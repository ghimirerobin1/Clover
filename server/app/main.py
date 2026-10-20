"""Stockroom Clover proxy. Run: uvicorn app.main:app  (set CLOVER_MOCK=1 to use fixtures)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .clover import CloverClient, CloverRegistry
from .config import Settings, get_settings
from .db import Database
from .errors import ApiError, ErrorCode
from .idempotency import IdempotencyStore
from .mock import MOCK_BASE_URL, MockClover
from .pairing import PairingService, PairingThrottle
from .ratelimit import TokenBucket
from .routes import catalog, health, pairing


class AppFactory:
    @staticmethod
    def clover_registry(
        settings: Settings, transport: httpx.AsyncBaseTransport | None, mock: MockClover | None
    ) -> CloverRegistry:
        # One bucket per token: Clover limits are per token. VERIFY: per-token vs per-merchant limits.

        def factory(location_id: str) -> CloverClient | None:
            loc = settings.location(location_id)
            if loc is None:
                return None
            return CloverClient(
                loc,
                base_url=MOCK_BASE_URL if mock else settings.clover_base_url,
                limiter=TokenBucket(settings.clover_rate_limit_per_sec, settings.clover_rate_limit_burst),
                max_get_attempts=settings.clover_max_get_attempts,
                timeout_sec=settings.clover_timeout_sec,
                transport=mock.transport() if mock else transport,
            )

        return CloverRegistry(factory)

    @staticmethod
    def create(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
        cfg = settings or get_settings()
        cfg.validate_for_startup()
        db = Database(cfg.database_path)
        db.migrate()
        mock = MockClover() if cfg.clover_mock and transport is None else None
        registry = AppFactory.clover_registry(cfg, transport, mock)

        @asynccontextmanager
        async def lifespan(_: FastAPI) -> AsyncIterator[None]:
            yield
            await registry.aclose()

        api = FastAPI(title="Stockroom proxy", version="0.1.0", lifespan=lifespan)
        api.state.settings = cfg
        api.state.db = db
        api.state.pairing = PairingService(db, cfg.pairing_code_ttl_sec)
        api.state.pairing_throttle = PairingThrottle(cfg.pairing_max_failures_per_min)
        api.state.idempotency = IdempotencyStore(db)
        api.state.clover = registry
        api.state.mock_clover = mock  # exposed for tests / dev tooling; None outside mock mode

        @api.exception_handler(ApiError)
        async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
            return JSONResponse(exc.to_body(), status_code=exc.http_status)

        @api.exception_handler(RequestValidationError)
        async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
            err = ApiError(ErrorCode.VALIDATION, "Invalid request", False, 422)
            body = err.to_body()
            body["error"]["details"] = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
            return JSONResponse(body, status_code=422)

        api.include_router(health.router)
        api.include_router(pairing.router)
        api.include_router(catalog.router)
        return api


def __getattr__(name: str) -> FastAPI:
    # Lazy so importing app.main in tests doesn't require env config.
    if name == "app":
        return AppFactory.create()
    raise AttributeError(name)
