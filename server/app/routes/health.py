from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from .. import __version__

router = APIRouter()


class HealthOut(BaseModel):
    status: str
    mock: bool
    version: str


@router.get("/health", response_model=HealthOut)
def health(request: Request) -> HealthOut:
    """Unauthenticated liveness check. Does not call Clover and reveals no config beyond mock mode."""
    return HealthOut(status="ok", mock=bool(request.app.state.settings.clover_mock), version=__version__)
