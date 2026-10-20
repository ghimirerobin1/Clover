"""Device pairing: an admin issues a short-lived code (python -m app.pair); the app redeems it for a key."""

from __future__ import annotations

import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta

from .db import Database
from .errors import ApiError, ErrorCode, ErrorMapper
from .security import Secrets
from .timeutil import Clock


@dataclass(frozen=True)
class Device:
    id: str
    name: str
    can_create_items: bool
    created_at: str


@dataclass(frozen=True)
class IssuedCode:
    code: str
    expires_at: datetime


@dataclass(frozen=True)
class PairedDevice:
    device: Device
    app_key: str  # returned exactly once, never stored raw


class PairingThrottle:
    """In-process sliding window of failed redemptions to make guessing 8-digit codes impractical."""

    def __init__(self, max_failures_per_min: int) -> None:
        self.max_failures = max_failures_per_min
        self._failures: deque[float] = deque()

    def _prune(self, now: float) -> None:
        while self._failures and now - self._failures[0] > 60:
            self._failures.popleft()

    def check(self, now: float | None = None) -> None:
        t = time.monotonic() if now is None else now
        self._prune(t)
        if len(self._failures) >= self.max_failures:
            raise ApiError(ErrorCode.RATE_LIMITED, "Too many failed pairing attempts; wait a minute", True, 429)

    def record_failure(self, now: float | None = None) -> None:
        self._failures.append(time.monotonic() if now is None else now)


class PairingService:
    def __init__(self, db: Database, code_ttl_sec: int) -> None:
        self.db = db
        self.code_ttl = timedelta(seconds=code_ttl_sec)

    def issue_code(self, *, can_create_items: bool = False, now: datetime | None = None) -> IssuedCode:
        code = Secrets.new_pairing_code()
        expires = (now or Clock.now()) + self.code_ttl
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO pairing_codes (code_hash, can_create_items, expires_at) VALUES (?, ?, ?)",
                (Secrets.hash(code), int(can_create_items), expires.isoformat()),
            )
        return IssuedCode(code=code, expires_at=expires)

    def redeem(self, code: str, device_name: str, *, now: datetime | None = None) -> PairedDevice:
        normalized = Secrets.normalize_code(code)
        name = device_name.strip()[:80]
        if not name:
            raise ErrorMapper.validation("deviceName is required")
        current = now or Clock.now()
        with self.db.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT can_create_items, expires_at, used_at FROM pairing_codes WHERE code_hash = ?",
                    (Secrets.hash(normalized),),
                ).fetchone()
                if row is None or row["used_at"] is not None or datetime.fromisoformat(row["expires_at"]) < current:
                    raise ErrorMapper.auth("Pairing code is invalid, expired, or already used")
                key = Secrets.new_device_key()
                device = Device(
                    id=str(uuid.uuid4()),
                    name=name,
                    can_create_items=bool(row["can_create_items"]),
                    created_at=current.isoformat(),
                )
                conn.execute(
                    "UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?",
                    (current.isoformat(), Secrets.hash(normalized)),
                )
                conn.execute(
                    "INSERT INTO devices (id, name, key_hash, can_create_items, created_at) VALUES (?, ?, ?, ?, ?)",
                    (device.id, device.name, Secrets.hash(key), int(device.can_create_items), device.created_at),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return PairedDevice(device=device, app_key=key)

    def authenticate(self, app_key: str | None) -> Device:
        if not app_key:
            raise ErrorMapper.auth()
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT id, name, can_create_items, created_at FROM devices WHERE key_hash = ? AND revoked_at IS NULL",
                (Secrets.hash(app_key),),
            ).fetchone()
            if row is None:
                raise ErrorMapper.auth()
            conn.execute("UPDATE devices SET last_seen_at = ? WHERE id = ?", (Clock.iso(), row["id"]))
        return Device(row["id"], row["name"], bool(row["can_create_items"]), row["created_at"])

    def list_devices(self) -> list[dict[str, object]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT id, name, can_create_items, created_at, last_seen_at, revoked_at FROM devices "
                "ORDER BY created_at"
            ).fetchall()
        return [dict(r) for r in rows]

    def revoke(self, device_id: str) -> bool:
        with self.db.connect() as conn:
            cur = conn.execute(
                "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (Clock.iso(), device_id)
            )
        return cur.rowcount == 1
