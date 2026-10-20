from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..auth import CurrentDevice
from ..clover import CloverRegistry
from ..stock import AuditLog, AuditPage, StockAction, StockService, StockWriteIn, StockWriteOut

router = APIRouter(prefix="/locations/{location_id}")


@router.post("/stock/{item_id}", response_model=StockWriteOut, response_model_by_alias=True)
async def write_stock(
    location_id: str, item_id: str, body: StockWriteIn, request: Request, device: CurrentDevice
) -> StockWriteOut:
    """Absolute stock write guarded by expectedQuantity (409 + live value on mismatch) and clientMutationId."""
    registry: CloverRegistry = request.app.state.clover
    return await StockService.write(
        db=request.app.state.db,
        idem=request.app.state.idempotency,
        clover=registry.get(location_id),
        device=device,
        location_id=location_id,
        item_id=item_id,
        body=body,
    )


@router.get("/audit", response_model=AuditPage, response_model_by_alias=True)
def audit_feed(
    location_id: str,
    request: Request,
    _device: CurrentDevice,
    item_id: Annotated[str | None, Query(alias="itemId", max_length=64)] = None,
    action: StockAction | None = None,
    since: Annotated[str | None, Query(max_length=40, description="ISO timestamp, inclusive")] = None,
    before: Annotated[int | None, Query(ge=1, description="Cursor: audit id")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> AuditPage:
    """Source of truth for 'recent stock changes' across all devices."""
    request.app.state.clover.get(location_id)  # 404 for unknown locations
    return AuditLog.page(
        request.app.state.db,
        location_id,
        item_id=item_id,
        action=action.value if action else None,
        since=since,
        before=before,
        limit=limit,
    )
