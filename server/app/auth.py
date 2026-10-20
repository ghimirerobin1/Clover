from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, Request

from .pairing import Device, PairingService


class Auth:
    @staticmethod
    def pairing(request: Request) -> PairingService:
        service: PairingService = request.app.state.pairing
        return service

    @staticmethod
    def device(request: Request, x_app_key: Annotated[str | None, Header(alias="X-App-Key")] = None) -> Device:
        """Every Clover-facing route depends on this: a valid, unrevoked per-device key."""
        return Auth.pairing(request).authenticate(x_app_key)


CurrentDevice = Annotated[Device, Depends(Auth.device)]
