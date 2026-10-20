"""Clover REST client: auth, token-bucket rate limiting, GET-only retries on 429, stable error mapping,
idempotent (never auto-retried) writes.

Everything uncertain about Clover's API lives in this file (and mock.py) and is tagged `VERIFY:`.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from enum import StrEnum
from typing import Any

import httpx

from .config import LocationConfig
from .errors import ApiError, ErrorMapper
from .idempotency import IdempotencyStore
from .ratelimit import TokenBucket
from .timeutil import Clock

MAX_BACKOFF_SEC = 30.0


class WriteOutcome(StrEnum):
    APPLIED = "applied"
    REJECTED = "rejected"  # definite 4xx: nothing written
    NOT_APPLIED = "not_applied"  # 429: nothing written
    UNKNOWN = "unknown"  # transport failure / 5xx: may or may not have been written


@dataclass(frozen=True)
class SentWrite:
    outcome: WriteOutcome
    status_code: int | None
    body: Any
    error: ApiError | None


@dataclass(frozen=True)
class WriteResult:
    status_code: int
    body: Any
    replayed: bool


class RetryPolicy:
    """Backoff for GET retries after 429. Pure functions, unit-tested."""

    BASE_SEC = 0.5

    @staticmethod
    def parse_retry_after(value: str | None) -> float | None:
        if not value:
            return None
        value = value.strip()
        try:
            seconds = float(value)
        except ValueError:
            try:
                seconds = (parsedate_to_datetime(value) - Clock.now()).total_seconds()
            except (TypeError, ValueError):
                return None
        return float(max(0.0, min(seconds, MAX_BACKOFF_SEC)))

    @staticmethod
    def delay(attempt: int, retry_after: float | None, rng: Callable[[], float] = random.random) -> float:
        """attempt is 0-based (0 = first retry). Honors Retry-After as a floor, adds jitter."""
        backoff = min(MAX_BACKOFF_SEC, RetryPolicy.BASE_SEC * (2.0**attempt))
        jittered = backoff * (0.5 + rng() / 2)
        return min(MAX_BACKOFF_SEC, max(retry_after or 0.0, jittered))


class CloverClient:
    def __init__(
        self,
        location: LocationConfig,
        *,
        base_url: str,
        limiter: TokenBucket,
        max_get_attempts: int = 4,
        timeout_sec: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self.location = location
        self.limiter = limiter
        self.max_get_attempts = max_get_attempts
        self._sleep = sleep
        self._rng = rng
        # VERIFY: Clover REST auth is `Authorization: Bearer <token>` for merchant API tokens.
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {location.api_token}", "Accept": "application/json"},
            timeout=timeout_sec,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def merchant_path(self, path: str) -> str:
        """Callers pass merchant-relative paths (e.g. "/items"); merchant id is server config only."""
        return f"/v3/merchants/{self.location.merchant_id}/{path.lstrip('/')}"

    @staticmethod
    def _body(resp: httpx.Response) -> Any:
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return None

    @staticmethod
    def _detail(resp: httpx.Response) -> str | None:
        # VERIFY: Clover error bodies carry a human-readable `message` field.
        body = CloverClient._body(resp)
        if isinstance(body, dict) and isinstance(body.get("message"), str):
            return str(body["message"])[:200]
        return None

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = self.merchant_path(path)
        for attempt in range(self.max_get_attempts):
            await self.limiter.acquire()
            try:
                resp = await self._http.get(url, params=params)
            except httpx.TransportError as exc:
                raise ErrorMapper.from_transport(exc, is_write=False) from exc
            if resp.status_code == 429 and attempt + 1 < self.max_get_attempts:
                retry_after = RetryPolicy.parse_retry_after(resp.headers.get("Retry-After"))
                await self._sleep(RetryPolicy.delay(attempt, retry_after, self._rng))
                continue
            if resp.is_success:
                return self._body(resp)
            raise ErrorMapper.from_status(resp.status_code, is_write=False, detail=self._detail(resp))
        raise AssertionError("unreachable")  # pragma: no cover

    async def send_write(self, method: str, path: str, body: Any) -> SentWrite:
        """One attempt, never retried, no idempotency bookkeeping. Classifies the outcome for the caller."""
        url = self.merchant_path(path)
        await self.limiter.acquire()
        try:
            resp = await self._http.request(method.upper(), url, json=body)
        except httpx.TransportError as exc:
            return SentWrite(WriteOutcome.UNKNOWN, None, None, ErrorMapper.from_transport(exc, is_write=True))
        if resp.status_code == 429:
            return SentWrite(WriteOutcome.NOT_APPLIED, 429, None, ErrorMapper.from_status(429, is_write=True))
        if resp.status_code >= 500:
            return SentWrite(
                WriteOutcome.UNKNOWN, resp.status_code, None, ErrorMapper.from_status(resp.status_code, is_write=True)
            )
        payload = self._body(resp)
        if not resp.is_success:
            err = ErrorMapper.from_status(resp.status_code, is_write=True, detail=self._detail(resp))
            return SentWrite(WriteOutcome.REJECTED, resp.status_code, payload, err)
        return SentWrite(WriteOutcome.APPLIED, resp.status_code, payload, None)

    async def write(
        self,
        method: str,
        path: str,
        body: Any,
        *,
        idempotency: IdempotencyStore,
        device_id: str,
        client_mutation_id: str,
    ) -> WriteResult:
        """Single attempt, never retried. A replay of a completed mutation returns the stored result."""
        req_hash = IdempotencyStore.request_hash(method, self.merchant_path(path), body)
        replay = idempotency.begin(device_id, client_mutation_id, req_hash)
        if replay is not None:
            if replay.status_code >= 400:
                raise ErrorMapper.from_status(replay.status_code, is_write=True)
            return WriteResult(replay.status_code, replay.body, replayed=True)

        try:
            sent = await self.send_write(method, path, body)
        except BaseException:
            idempotency.release(device_id, client_mutation_id)
            raise
        if sent.outcome is WriteOutcome.NOT_APPLIED:
            # Definitely not applied: free the id so the user can re-confirm later.
            idempotency.release(device_id, client_mutation_id)
        elif sent.outcome is not WriteOutcome.UNKNOWN:
            # Unknown outcome keeps the 'pending' row so a blind retry with the same id is refused.
            idempotency.complete(device_id, client_mutation_id, sent.status_code or 0, sent.body)
        if sent.error is not None:
            raise sent.error
        return WriteResult(sent.status_code or 200, sent.body, replayed=False)


class CloverRegistry:
    """One CloverClient per configured location."""

    def __init__(self, factory: Callable[[str], CloverClient | None]) -> None:
        self._factory = factory
        self._clients: dict[str, CloverClient] = {}

    def get(self, location_id: str) -> CloverClient:
        client = self._clients.get(location_id)
        if client is None:
            created = self._factory(location_id)
            if created is None:
                raise ErrorMapper.not_found(f"Unknown location '{location_id}'")
            self._clients[location_id] = client = created
        return client

    async def aclose(self) -> None:
        for client in self._clients.values():
            await client.aclose()
        self._clients.clear()


__all__ = ["ApiError", "CloverClient", "CloverRegistry", "RetryPolicy", "WriteResult"]
