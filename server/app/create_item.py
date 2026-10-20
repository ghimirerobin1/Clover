"""Gated item creation (spec §4.6). Off unless the device key carries canCreateItems.

One Clover write per step, never retried. The create itself is idempotent per (device, clientMutationId):
a replay returns the stored result; an unknown outcome keeps the id pending so a blind retry is refused.
Follow-up steps (category link, initial stock) run once after the item exists; their failures are returned
as warnings rather than retried, because the item has already been created.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field, field_validator

from .catalog import CamelModel, Catalog, ItemOut
from .clover import CloverClient, WriteOutcome
from .db import Database
from .errors import ApiError, ErrorCode
from .idempotency import IdempotencyStore
from .pairing import Device
from .stock import MAX_QTY, AuditLog
from .timeutil import Clock

MAX_PRICE_CENTS = 100_000_000  # $1,000,000.00


class CreateItemIn(CamelModel):
    name: str = Field(min_length=1, max_length=127)
    price_cents: int = Field(ge=0, le=MAX_PRICE_CENTS)
    code: str | None = Field(default=None, max_length=64)
    sku: str | None = Field(default=None, max_length=64)
    category_id: str | None = Field(default=None, max_length=64)
    initial_stock: int | None = Field(default=None, ge=0, le=MAX_QTY)
    client_mutation_id: str = Field(min_length=8, max_length=128)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name is required")
        return v

    @field_validator("code", "sku", "category_id")
    @classmethod
    def _blank_is_none(cls, v: str | None) -> str | None:
        return v.strip() or None if v is not None else None


class CreateItemOut(CamelModel):
    item: ItemOut
    warnings: list[str] = []
    audit_id: int
    replayed: bool = False


class CreateItemService:
    @staticmethod
    def forbidden() -> ApiError:
        return ApiError(
            ErrorCode.AUTH, "This device is not allowed to create items (canCreateItems is off)", False, 403
        )

    @staticmethod
    def clover_body(body: CreateItemIn) -> dict[str, Any]:
        # VERIFY: POST /v3/merchants/{mId}/items accepts {name, price (cents), priceType, sku, code}.
        out: dict[str, Any] = {"name": body.name, "price": body.price_cents, "priceType": "FIXED"}
        if body.sku:
            out["sku"] = body.sku
        if body.code:
            out["code"] = body.code
        return out

    @staticmethod
    async def create(
        *,
        db: Database,
        idem: IdempotencyStore,
        clover: CloverClient,
        device: Device,
        location_id: str,
        body: CreateItemIn,
    ) -> CreateItemOut:
        if not device.can_create_items:
            raise CreateItemService.forbidden()
        req = body.model_dump(mode="json", by_alias=True)
        req_hash = IdempotencyStore.request_hash("POST", f"/locations/{location_id}/items", req)
        replay = idem.begin(device.id, body.client_mutation_id, req_hash)
        if replay is not None:
            if replay.status_code == 200:
                out = CreateItemOut.model_validate(replay.body)
                out.replayed = True
                return out
            err = replay.body.get("error", {}) if isinstance(replay.body, dict) else {}
            raise ApiError(
                ErrorCode(err.get("code", "UPSTREAM")),
                str(err.get("message", "Replayed error")),
                False,
                replay.status_code,
            )

        sent = await clover.send_write("POST", "/items", CreateItemService.clover_body(body))
        audit = dict(
            device_id=device.id,
            location_id=location_id,
            item_name=body.name,
            action="create",
            reason=None,
            note=None,
            client_mutation_id=body.client_mutation_id,
            created_at=Clock.iso(),
            before_qty=None,
        )
        if sent.outcome is not WriteOutcome.APPLIED:
            status = "unknown" if sent.outcome is WriteOutcome.UNKNOWN else "rejected"
            AuditLog.record(db, **audit, item_id="", after_qty=None, status=status, clover_status=sent.status_code)
            assert sent.error is not None
            if sent.outcome is WriteOutcome.NOT_APPLIED:
                idem.release(device.id, body.client_mutation_id)
            elif sent.outcome is WriteOutcome.REJECTED:
                idem.complete(device.id, body.client_mutation_id, sent.error.http_status, sent.error.to_body())
            raise sent.error  # UNKNOWN: id stays pending (re-check by barcode before trying again)

        item = Catalog.item(sent.body)
        warnings: list[str] = []
        if body.category_id:
            # VERIFY: category link via POST /v3/merchants/{mId}/category_items {"elements":[{item, category}]}.
            link = await clover.send_write(
                "POST",
                "/category_items",
                {"elements": [{"item": {"id": item.id}, "category": {"id": body.category_id}}]},
            )
            if link.outcome is WriteOutcome.APPLIED:
                item.category_id = body.category_id
            else:
                warnings.append(
                    f"Item created, but adding it to the category failed: {link.error.message if link.error else ''}"
                )
        if body.initial_stock is not None:
            # VERIFY: initial stock via POST item_stocks/{id} works on a new item (stock tracking may need enabling).
            stock = await clover.send_write("POST", f"/item_stocks/{item.id}", {"quantity": body.initial_stock})
            if stock.outcome is WriteOutcome.APPLIED:
                item.stock_qty = float(body.initial_stock)
            else:
                warnings.append(
                    f"Item created, but setting initial stock failed: {stock.error.message if stock.error else ''}"
                )

        audit_id = AuditLog.record(
            db,
            **audit,
            item_id=item.id,
            after_qty=item.stock_qty,
            status="applied" if not warnings else "partial",
            clover_status=sent.status_code,
        )
        out = CreateItemOut(item=item, warnings=warnings, audit_id=audit_id)
        idem.complete(device.id, body.client_mutation_id, 200, out.model_dump(mode="json", by_alias=True))
        return out
