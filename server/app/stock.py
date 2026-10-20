"""Stock writes with the read-verify-write protocol (spec §0.3, §3, §4.4).

Clover stock writes are ABSOLUTE. So for every write we:
  1. claim the (device, clientMutationId) in the idempotency table (a replay returns the stored result),
  2. re-read live stock from Clover,
  3. if live != expectedQuantity -> 409 with the live value, nothing written,
  4. otherwise POST the absolute newQuantity once (never retried),
  5. audit-log the attempt (applied / conflict / rejected / unknown).
"""

from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from enum import StrEnum
from typing import Any

from pydantic import Field, field_validator

from .catalog import ITEM_EXPAND, CamelModel, Catalog
from .clover import CloverClient, WriteOutcome
from .db import Database
from .errors import ApiError, ErrorCode, ErrorMapper
from .idempotency import IdempotencyStore
from .pairing import Device
from .timeutil import Clock

MAX_QTY = 1_000_000


class StockAction(StrEnum):
    RECEIVE = "receive"
    COUNT = "count"
    ADJUST = "adjust"
    UNDO = "undo"


class AdjustReason(StrEnum):
    DAMAGED = "damaged"
    EXPIRED = "expired"
    THEFT_LOSS = "theft_loss"
    CORRECTION = "correction"
    OTHER = "other"


class StockWriteIn(CamelModel):
    expected_quantity: float
    new_quantity: float = Field(ge=0, le=MAX_QTY)
    action: StockAction
    reason: AdjustReason | None = None
    note: str | None = Field(default=None, max_length=200)
    client_mutation_id: str = Field(min_length=8, max_length=128)

    @field_validator("expected_quantity", "new_quantity")
    @classmethod
    def _finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("must be finite")
        return v

    def check(self) -> None:
        if self.action is StockAction.ADJUST and self.reason is None:
            raise ErrorMapper.validation("reason is required for adjust")


class StockWriteOut(CamelModel):
    item_id: str
    previous_quantity: float
    new_quantity: float
    audit_id: int
    replayed: bool = False


class StockConflict(ApiError):
    """409 carrying the live quantity so the app can re-confirm from the new base."""

    def __init__(self, current_quantity: float) -> None:
        super().__init__(ErrorCode.CONFLICT, f"Stock changed to {current_quantity:g} since you opened this", False, 409)
        self.current_quantity = current_quantity

    def to_body(self) -> dict[str, dict[str, object]]:
        body = super().to_body()
        body["error"]["currentQuantity"] = self.current_quantity
        return body


class AuditEntry(CamelModel):
    id: int
    item_id: str
    item_name: str | None
    action: str
    before_qty: float | None
    after_qty: float | None
    reason: str | None
    note: str | None
    status: str
    device_id: str
    device_name: str | None
    client_mutation_id: str | None
    created_at: str


class AuditPage(CamelModel):
    entries: list[AuditEntry]
    next_before: int | None


class AuditLog:
    @staticmethod
    def record(db: Database, **row: Any) -> int:
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        with db.connect() as conn:
            cur = conn.execute(f"INSERT INTO audit_log ({cols}) VALUES ({marks})", tuple(row.values()))  # noqa: S608
            return int(cur.lastrowid or 0)

    @staticmethod
    def page(
        db: Database,
        location_id: str,
        *,
        item_id: str | None = None,
        action: str | None = None,
        since: str | None = None,
        before: int | None = None,
        limit: int = 50,
    ) -> AuditPage:
        where = ["a.location_id = ?"]
        params: list[Any] = [location_id]
        for clause, value in (
            ("a.item_id = ?", item_id),
            ("a.action = ?", action),
            ("a.created_at >= ?", since),
            ("a.id < ?", before),
        ):
            if value is not None:
                where.append(clause)
                params.append(value)
        # WHERE clauses are fixed strings above; all values are bound parameters.
        select = "SELECT a.*, d.name AS device_name FROM audit_log a LEFT JOIN devices d ON d.id = a.device_id"
        sql = f"{select} WHERE {' AND '.join(where)} ORDER BY a.id DESC LIMIT ?"  # noqa: S608
        with db.connect() as conn:
            rows = conn.execute(sql, (*params, limit + 1)).fetchall()
        entries = [AuditEntry.model_validate(dict(r)) for r in rows[:limit]]
        return AuditPage(entries=entries, next_before=entries[-1].id if len(rows) > limit else None)


class StockService:
    # Serialize our own writes per item so two devices can't interleave read/verify/write.
    _locks: defaultdict[tuple[str, str], asyncio.Lock] = defaultdict(asyncio.Lock)

    @staticmethod
    def wire_qty(q: float) -> int | float:
        """Whole numbers go to Clover as integers (VERIFY: whether fractional stock is accepted)."""
        return int(q) if q.is_integer() else q

    @staticmethod
    async def live_item(clover: CloverClient, item_id: str) -> tuple[float, str]:
        item = Catalog.item(await clover.get(f"/items/{item_id}", {"expand": ITEM_EXPAND}))
        if item.stock_qty is None:
            raise ErrorMapper.validation("Stock is not tracked for this item in Clover")
        return item.stock_qty, item.name

    @staticmethod
    async def write(
        *,
        db: Database,
        idem: IdempotencyStore,
        clover: CloverClient,
        device: Device,
        location_id: str,
        item_id: str,
        body: StockWriteIn,
    ) -> StockWriteOut:
        body.check()
        req = body.model_dump(mode="json", by_alias=True)
        req_hash = IdempotencyStore.request_hash("POST", f"/locations/{location_id}/stock/{item_id}", req)
        replay = idem.begin(device.id, body.client_mutation_id, req_hash)
        if replay is not None:
            return StockService._replay(replay.status_code, replay.body)

        async with StockService._locks[(location_id, item_id)]:
            try:
                live, name = await StockService.live_item(clover, item_id)
            except BaseException:
                # Nothing was written: free the id.
                idem.release(device.id, body.client_mutation_id)
                raise

            base = dict(
                device_id=device.id,
                location_id=location_id,
                item_id=item_id,
                item_name=name,
                action=body.action.value,
                reason=body.reason.value if body.reason else None,
                note=body.note,
                client_mutation_id=body.client_mutation_id,
                created_at=Clock.iso(),
            )
            if live != body.expected_quantity:
                conflict = StockConflict(live)
                AuditLog.record(db, **base, before_qty=live, after_qty=None, status="conflict", clover_status=None)
                idem.complete(device.id, body.client_mutation_id, 409, conflict.to_body())
                raise conflict

            # VERIFY: POST /v3/merchants/{mId}/item_stocks/{itemId} {"quantity": N} sets absolute stock.
            sent = await clover.send_write(
                "POST", f"/item_stocks/{item_id}", {"quantity": StockService.wire_qty(body.new_quantity)}
            )
            status = {
                WriteOutcome.APPLIED: "applied",
                WriteOutcome.REJECTED: "rejected",
                WriteOutcome.NOT_APPLIED: "rejected",
                WriteOutcome.UNKNOWN: "unknown",
            }[sent.outcome]
            audit_id = AuditLog.record(
                db, **base, before_qty=live, after_qty=body.new_quantity, status=status, clover_status=sent.status_code
            )
            if sent.outcome is WriteOutcome.UNKNOWN:
                # Leave the idempotency row pending: a blind retry with this id is refused (CONFLICT).
                assert sent.error is not None
                raise sent.error
            if sent.outcome is WriteOutcome.NOT_APPLIED:
                idem.release(device.id, body.client_mutation_id)
                assert sent.error is not None
                raise sent.error
            if sent.error is not None:
                idem.complete(device.id, body.client_mutation_id, sent.error.http_status, sent.error.to_body())
                raise sent.error

            qty = sent.body.get("quantity") if isinstance(sent.body, dict) else None
            out = StockWriteOut(
                item_id=item_id,
                previous_quantity=live,
                new_quantity=float(qty) if isinstance(qty, int | float) else body.new_quantity,
                audit_id=audit_id,
            )
            idem.complete(device.id, body.client_mutation_id, 200, out.model_dump(mode="json", by_alias=True))
            return out

    @staticmethod
    def _replay(status_code: int, stored: Any) -> StockWriteOut:
        if status_code == 200:
            out = StockWriteOut.model_validate(stored)
            out.replayed = True
            return out
        err = stored.get("error", {}) if isinstance(stored, dict) else {}
        if status_code == 409 and isinstance(err.get("currentQuantity"), int | float):
            raise StockConflict(float(err["currentQuantity"]))
        code = ErrorCode(err.get("code", ErrorCode.UPSTREAM.value))
        raise ApiError(code, str(err.get("message", "Replayed error")), False, status_code)
