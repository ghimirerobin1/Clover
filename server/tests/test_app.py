from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.clover import CloverRegistry
from app.errors import ApiError, ErrorCode
from app.idempotency import IdempotencyStore
from app.main import AppFactory

from .conftest import make_settings


def test_health(api: TestClient) -> None:
    res = api.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "mock": True, "version": "0.1.0"}


def test_real_mode_requires_credentials(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError):
        AppFactory.create(make_settings(tmp_path, clover_mock=False))


def test_health_does_not_leak_secrets(tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path, clover_mock=False, clover_api_token="tok_SECRET", clover_merchant_id="MID_SECRET"
    )
    with TestClient(AppFactory.create(settings)) as client:
        text = client.get("/health").text
    assert "SECRET" not in text


async def test_mock_mode_serves_fixtures_end_to_end(api: TestClient) -> None:
    registry: CloverRegistry = api.app.state.clover  # type: ignore[attr-defined]
    idem: IdempotencyStore = api.app.state.idempotency  # type: ignore[attr-defined]
    clover = registry.get("default")

    items = await clover.get("/items", {"limit": 2, "offset": 0, "expand": "itemStock,categories"})
    assert len(items["elements"]) == 2
    cats = await clover.get("/categories")
    assert {c["id"] for c in cats["elements"]} >= {"CAT_RICE", "CAT_NOODLE"}

    item = await clover.get("/items/ITEM_RICE20")
    assert item["price"] == 2899 and isinstance(item["price"], int)  # integer cents

    res = await clover.write(
        "POST", "/item_stocks/ITEM_RICE20", {"quantity": 38}, idempotency=idem, device_id="d", client_mutation_id="c1"
    )
    assert res.body["quantity"] == 38
    assert (await clover.get("/items/ITEM_RICE20"))["itemStock"]["quantity"] == 38

    with pytest.raises(ApiError) as ei:
        await clover.get("/items/NOPE")
    assert ei.value.code is ErrorCode.NOT_FOUND


def test_unknown_location(api: TestClient) -> None:
    registry: CloverRegistry = api.app.state.clover  # type: ignore[attr-defined]
    with pytest.raises(ApiError) as ei:
        registry.get("store-2")
    assert ei.value.code is ErrorCode.NOT_FOUND
