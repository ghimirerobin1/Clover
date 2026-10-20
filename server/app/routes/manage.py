from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Request

from ..auth import CurrentDevice
from ..create_item import CreateItemIn, CreateItemOut, CreateItemService
from ..thresholds import ThresholdIn, ThresholdMap, Thresholds, ThresholdScope

router = APIRouter(prefix="/locations/{location_id}")


@router.post("/items", response_model=CreateItemOut, response_model_by_alias=True)
async def create_item(location_id: str, body: CreateItemIn, request: Request, device: CurrentDevice) -> CreateItemOut:
    """Gated by the device key's canCreateItems. Idempotent per clientMutationId; never retried."""
    clover = request.app.state.clover.get(location_id)
    return await CreateItemService.create(
        db=request.app.state.db,
        idem=request.app.state.idempotency,
        clover=clover,
        device=device,
        location_id=location_id,
        body=body,
    )


@router.get("/thresholds", response_model=ThresholdMap, response_model_by_alias=True)
def list_thresholds(location_id: str, request: Request, _device: CurrentDevice) -> ThresholdMap:
    request.app.state.clover.get(location_id)
    return Thresholds.all(request.app.state.db, location_id)


@router.put("/thresholds/{scope}/{ref_id}", response_model=ThresholdMap, response_model_by_alias=True)
def put_threshold(
    location_id: str,
    scope: ThresholdScope,
    ref_id: Annotated[str, Path(min_length=1, max_length=64)],
    body: ThresholdIn,
    request: Request,
    device: CurrentDevice,
) -> ThresholdMap:
    """Set (or clear with null) a shared threshold. Local proxy data only; nothing goes to Clover."""
    request.app.state.clover.get(location_id)
    Thresholds.set(request.app.state.db, location_id, scope, ref_id, body.threshold, device.id)
    return Thresholds.all(request.app.state.db, location_id)
