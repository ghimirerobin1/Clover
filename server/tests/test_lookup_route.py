from __future__ import annotations

from pathlib import Path

import httpx
import respx
from fastapi.testclient import TestClient

from app.catalog import ItemOut, Lookup
from app.main import AppFactory
from app.mock import MockClover
from app.pairing import PairingService

from .conftest import make_settings

URL = "/locations/default/items/lookup"


def _key(client: TestClient) -> dict[str, str]:
    service: PairingService = client.app.state.pairing  # type: ignore[attr-defined]
    return {"X-App-Key": service.redeem(service.issue_code().code, "t").app_key}


def test_requires_key(api: TestClient) -> None:
    assert api.get(URL, params={"code": "074410000123"}).status_code == 401


def test_match_by_upc(api: TestClient) -> None:
    res = api.get(URL, params={"code": "074410000123"}, headers=_key(api)).json()
    assert res["match"]["id"] == "ITEM_RICE20" and res["candidates"] == []


def test_match_by_ean13_form_of_stored_upca(api: TestClient) -> None:
    res = api.get(URL, params={"code": "0074410000123"}, headers=_key(api)).json()
    assert res["match"]["id"] == "ITEM_RICE20"


def test_match_by_sku(api: TestClient) -> None:
    res = api.get(URL, params={"code": "NOOD-SHIN-4"}, headers=_key(api)).json()
    assert res["match"]["id"] == "ITEM_RAMEN"


def test_not_found(api: TestClient) -> None:
    assert api.get(URL, params={"code": "999999999999"}, headers=_key(api)).json() == {"match": None, "candidates": []}


def test_duplicates_become_candidates(api: TestClient) -> None:
    mock: MockClover = api.app.state.mock_clover  # type: ignore[attr-defined]
    dup = dict(mock.items["ITEM_POCKY"], id="ITEM_POCKY2", name="Pocky Chocolate (case)")
    mock.items["ITEM_POCKY2"] = dup
    res = api.get(URL, params={"code": "073141150019"}, headers=_key(api)).json()
    assert res["match"] is None
    assert {c["id"] for c in res["candidates"]} == {"ITEM_POCKY", "ITEM_POCKY2"}


def test_lookup_route_not_shadowed_by_item_id(api: TestClient) -> None:
    # /items/lookup must not be parsed as /items/{id="lookup"}
    res = api.get(URL, params={"code": "x"}, headers=_key(api))
    assert res.status_code == 200 and "match" in res.json()


def test_validation(api: TestClient) -> None:
    h = _key(api)
    assert api.get(URL, headers=h).json()["error"]["code"] == "VALIDATION"
    assert api.get(URL, params={"code": "   "}, headers=h).status_code == 422
    assert api.get(URL, params={"code": "1" * 65}, headers=h).status_code == 422


@respx.mock
def test_real_mode_tries_code_then_variants_then_sku(tmp_path: Path) -> None:
    settings = make_settings(
        tmp_path, clover_mock=False, clover_api_token="t", clover_merchant_id="M1", clover_base_url="https://c.test"
    )
    route = respx.get("https://c.test/v3/merchants/M1/items").mock(
        return_value=httpx.Response(200, json={"elements": []})
    )
    with TestClient(AppFactory.create(settings)) as client:
        res = client.get(URL, params={"code": "074410000123"}, headers=_key(client))
    assert res.json() == {"match": None, "candidates": []}
    filters = [c.request.url.params["filter"] for c in route.calls]
    assert filters == ["code=074410000123", "code=0074410000123", "sku=074410000123"]
    assert route.calls.last.request.url.params["expand"] == "itemStock,categories"


def test_code_variants() -> None:
    assert Lookup.code_variants("036000291452") == ["036000291452", "0036000291452"]
    assert Lookup.code_variants("0036000291452") == ["0036000291452", "036000291452"]
    assert Lookup.code_variants("4006381333931") == ["4006381333931"]
    assert Lookup.code_variants("ABC") == ["ABC"]


def test_result_ignores_deleted() -> None:
    base = {
        "name": "n",
        "sku": None,
        "code": "1",
        "price_cents": 1,
        "cost_cents": None,
        "category_id": None,
        "stock_qty": 1,
        "modified_time": 1,
    }
    a = ItemOut(id="A", **base)  # type: ignore[arg-type]
    b = ItemOut(id="B", deleted=True, **base)  # type: ignore[arg-type]
    assert Lookup.result([a, b]).match == a
