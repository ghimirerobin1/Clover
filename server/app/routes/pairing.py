from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from ..auth import Auth, CurrentDevice
from ..errors import ApiError, ErrorCode
from ..pairing import PairingService, PairingThrottle

router = APIRouter()


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PairIn(CamelModel):
    code: str = Field(min_length=1, max_length=32)
    device_name: str = Field(min_length=1, max_length=80)


class DeviceOut(CamelModel):
    id: str
    name: str
    can_create_items: bool


class PairOut(CamelModel):
    app_key: str
    device: DeviceOut


@router.post("/pair", response_model=PairOut, response_model_by_alias=True)
def pair(body: PairIn, request: Request, service: Annotated[PairingService, Depends(Auth.pairing)]) -> PairOut:
    throttle: PairingThrottle = request.app.state.pairing_throttle
    throttle.check()
    try:
        paired = service.redeem(body.code, body.device_name)
    except ApiError as e:
        if e.code == ErrorCode.AUTH:
            throttle.record_failure()
        raise
    d = paired.device
    return PairOut(app_key=paired.app_key, device=DeviceOut(id=d.id, name=d.name, can_create_items=d.can_create_items))


@router.get("/me", response_model=DeviceOut, response_model_by_alias=True)
def me(device: CurrentDevice) -> DeviceOut:
    """Lets the app verify its stored X-App-Key is still valid."""
    return DeviceOut(id=device.id, name=device.name, can_create_items=device.can_create_items)
