from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.catalog import Catalog
from app.errors import ApiError
from app.main import AppFactory
from app.mock import MockClover
from app.pairing import PairingService

from .conftest import make_settings


def _key(client: TestClient) -> dict[str, str]:
    service: PairingService = client.app.state.pairing  # type: ignore[attr-defined]
    paired = service.redeem(service.issue_code().code, "test")
    return {"X-App-Key": paired.app_key}


def test_routes_require_key(api: TestClient) -> None:
    for path in ("/locations/default/items", "/locations/default/items/ITEM_RICE20", "/locations/default/categories"):
        res = api.get(path)
        assert res.status_code == 401 and res.json()["error"]["code"] == "AUTH"


def test_items_paginated(api: TestClient) -> None:
    h = _key(api)
    first = api.get("/locations/default/items", params={"limit": 4, "offset": 0}, headers=h).json()
    second = api.get("/locations/default/items", params={"limit": 4, "offset": 4}, headers=h).json()
    assert len(first["items"]) == 4 and first["hasMore"] is True
    assert len(second["items"]) == 2 and second["hasMore"] is False
    ids = [i["id"] for i in first["items"] + second["items"]]
    assert len(set(ids)) == 6
    rice = next(i for i in first["items"] + second["items"] if i["id"] == "ITEM_RICE20")
    assert rice == {
        "id": "ITEM_RICE20",
        "name": "Jasmine Rice 20lb",
        "sku": "RICE-JAS-20",
        "code": "074410000123",
        "priceCents": 2899,
        "costCents": 2100,
        "categoryId": "CAT_RICE",
        "stockQty": 14,
        "modifiedTime": 1760000000000,
        "deleted": False,
    }


def test_items_modified_since(api: TestClient) -> None:
    h = _key(api)
    res = api.get("/locations/default/items", params={"modifiedSince": 1760000400000}, headers=h).json()
    assert {i["id"] for i in res["items"]} == {"ITEM_PORKBELLY", "ITEM_NOSTOCK"}


def test_untracked_stock_is_null(api: TestClient) -> None:
    res = api.get("/locations/default/items/ITEM_NOSTOCK", headers=_key(api)).json()
    assert res["stockQty"] is None and res["code"] is None


def test_item_not_found_and_bad_location(api: TestClient) -> None:
    h = _key(api)
    assert api.get("/locations/default/items/NOPE", headers=h).json()["error"]["code"] == "NOT_FOUND"
    assert api.get("/locations/store-2/items", headers=h).status_code == 404


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 1001}, {"offset": -1}, {"modifiedSince": "x"}])
def test_list_validation(api: TestClient, params: dict[str, object]) -> None:
    res = api.get("/locations/default/items", params=params, headers=_key(api))
    assert res.status_code == 422 and res.json()["error"]["code"] == "VALIDATION"


def test_categories(api: TestClient) -> None:
    cats = api.get("/locations/default/categories", headers=_key(api)).json()["categories"]
    assert cats[0] == {"id": "CAT_RICE", "name": "Rice & Grains", "sortOrder": 1}


def test_item_fetch_is_fresh_not_cached(api: TestClient) -> None:
    h = _key(api)
    mock: MockClover = api.app.state.mock_clover  # type: ignore[attr-defined]
    assert api.get("/locations/default/items/ITEM_RAMEN", headers=h).json()["stockQty"] == 3
    # Simulate a POS sale changing stock upstream.
    mock.items["ITEM_RAMEN"]["itemStock"]["quantity"] = 2
    assert api.get("/locations/default/items/ITEM_RAMEN", headers=h).json()["stockQty"] == 2


@respx.mock
def test_real_mode_sends_expand_and_filter(tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path, clover_mock=False, clover_api_token="t", clover_merchant_id="M1", clover_base_url="https://c.test"
    )
    route = respx.get("https://c.test/v3/merchants/M1/items").mock(
        return_value=httpx.Response(200, json={"elements": []})
    )
    with TestClient(AppFactory.create(settings)) as client:
        res = client.get("/locations/default/items", params={"limit": 1000, "modifiedSince": 5}, headers=_key(client))
    assert res.status_code == 200 and res.json()["hasMore"] is False
    params = route.calls.last.request.url.params
    assert params["expand"] == "itemStock,categories"
    assert params["filter"] == "modifiedTime>=5"
    assert params["limit"] == "1000"


@pytest.mark.parametrize(
    "raw",
    [{"name": "no id"}, {"id": "X", "price": "12.99"}, {"id": "X", "itemStock": {"quantity": "lots"}}, "nope"],
)
def test_malformed_items_fail_loudly(raw: object) -> None:
    with pytest.raises(ApiError) as ei:
        Catalog.item(raw)
    assert ei.value.code.value == "UPSTREAM"


def test_price_must_be_integer_cents() -> None:
    with pytest.raises(ApiError):
        Catalog.item({"id": "X", "price": 12.99})
