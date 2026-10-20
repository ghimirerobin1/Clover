from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import httpx
import respx
from fastapi.testclient import TestClient

from app.main import AppFactory
from app.mock import MockClover
from app.pairing import PairingService

from .conftest import make_settings

URL = "/locations/default/items"


def _key(client: TestClient, *, create: bool, name: str = "Front") -> dict[str, str]:
    service: PairingService = client.app.state.pairing  # type: ignore[attr-defined]
    return {"X-App-Key": service.redeem(service.issue_code(can_create_items=create).code, name).app_key}


def _body(**over: Any) -> dict[str, Any]:
    return {
        "name": "Mango Lassi 300ml",
        "priceCents": 349,
        "code": "012345678905",
        "sku": "BEV-LASSI",
        "categoryId": "CAT_BEV",
        "initialStock": 12,
        "clientMutationId": str(uuid.uuid4()),
        **over,
    }


def _mock(api: TestClient) -> MockClover:
    return api.app.state.mock_clover  # type: ignore[attr-defined, no-any-return]


def _audit(api: TestClient, h: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = api.get("/locations/default/audit", headers=h).json()["entries"]
    return entries


def test_create_requires_key(api: TestClient) -> None:
    assert api.post(URL, json=_body()).status_code == 401


def test_create_gated_off_by_default(api: TestClient) -> None:
    h = _key(api, create=False)
    before = len(_mock(api).items)
    res = api.post(URL, json=_body(), headers=h)
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "AUTH"
    assert len(_mock(api).items) == before  # nothing reached Clover
    assert _audit(api, h) == []


def test_create_applies_and_audits(api: TestClient) -> None:
    h = _key(api, create=True)
    cats = {c["id"] for c in _mock(api).categories}
    cat = sorted(cats)[0]
    res = api.post(URL, json=_body(categoryId=cat), headers=h)
    assert res.status_code == 200, res.text
    out = res.json()
    item = out["item"]
    assert item["name"] == "Mango Lassi 300ml" and item["priceCents"] == 349
    assert item["code"] == "012345678905" and item["sku"] == "BEV-LASSI"
    assert item["categoryId"] == cat and item["stockQty"] == 12
    assert out["warnings"] == [] and out["replayed"] is False
    stored = _mock(api).items[item["id"]]
    assert stored["price"] == 349 and stored["itemStock"]["quantity"] == 12
    [entry] = _audit(api, h)
    assert entry["action"] == "create" and entry["itemId"] == item["id"] and entry["afterQty"] == 12
    # It is now visible through the normal read path.
    assert api.get(f"/locations/default/items/{item['id']}", headers=h).json()["stockQty"] == 12


def test_create_replay_is_idempotent(api: TestClient) -> None:
    h = _key(api, create=True)
    body = _body(categoryId=None)
    first = api.post(URL, json=body, headers=h).json()
    count = len(_mock(api).items)
    again = api.post(URL, json=body, headers=h)
    assert again.status_code == 200
    assert again.json()["replayed"] is True and again.json()["item"]["id"] == first["item"]["id"]
    assert len(_mock(api).items) == count  # no second item
    assert len(_audit(api, h)) == 1
    reuse = api.post(URL, json={**body, "name": "Other"}, headers=h)
    assert reuse.status_code == 409


def test_create_validation(api: TestClient) -> None:
    h = _key(api, create=True)
    for bad in (
        {"name": "   "},
        {"priceCents": -1},
        {"priceCents": 3.49},
        {"initialStock": -2},
        {"initialStock": 1.5},
        {"clientMutationId": "short"},
        {"name": "x" * 200},
    ):
        res = api.post(URL, json=_body(**bad), headers=h)
        assert res.status_code == 422, bad
    assert _audit(api, h) == []


def test_create_without_optional_fields_leaves_stock_untracked(api: TestClient) -> None:
    h = _key(api, create=True)
    res = api.post(URL, json=_body(code=" ", sku="", categoryId=None, initialStock=None), headers=h)
    item = res.json()["item"]
    assert item["code"] is None and item["sku"] is None and item["stockQty"] is None


def _real(tmp_path: Path) -> TestClient:
    settings = make_settings(
        tmp_path, clover_mock=False, clover_api_token="t", clover_merchant_id="M1", clover_base_url="https://c.test"
    )
    return TestClient(AppFactory.create(settings))


@respx.mock
def test_create_unknown_outcome_is_not_retried_and_id_stays_pending(tmp_path: Path) -> None:
    post = respx.post("https://c.test/v3/merchants/M1/items").mock(side_effect=httpx.ReadTimeout("lost"))
    with _real(tmp_path) as client:
        h = _key(client, create=True)
        body = _body(categoryId=None, initialStock=None)
        res = client.post(URL, json=body, headers=h)
        assert res.status_code == 502 and res.json()["error"]["retryable"] is False
        assert post.call_count == 1
        again = client.post(URL, json=body, headers=h)
        assert again.status_code == 409  # pending: blind retry refused
        assert post.call_count == 1
        assert _audit(client, h)[0]["status"] == "unknown"


@respx.mock
def test_create_rejected_is_stored_and_429_frees_id(tmp_path: Path) -> None:
    post = respx.post("https://c.test/v3/merchants/M1/items").mock(
        side_effect=[httpx.Response(429), httpx.Response(400, json={"message": "bad"})]
    )
    with _real(tmp_path) as client:
        h = _key(client, create=True)
        body = _body(categoryId=None, initialStock=None)
        assert client.post(URL, json=body, headers=h).status_code == 429
        assert client.post(URL, json=body, headers=h).status_code == 422  # id was freed, second attempt sent
        assert client.post(URL, json=body, headers=h).status_code == 422  # replayed, not sent again
        assert post.call_count == 2


@respx.mock
def test_create_followup_failure_becomes_warning_not_retry(tmp_path: Path) -> None:
    respx.post("https://c.test/v3/merchants/M1/items").mock(
        return_value=httpx.Response(200, json={"id": "NEW1", "name": "Lassi", "price": 349, "modifiedTime": 5})
    )
    stock = respx.post("https://c.test/v3/merchants/M1/item_stocks/NEW1").mock(return_value=httpx.Response(503))
    with _real(tmp_path) as client:
        h = _key(client, create=True)
        res = client.post(URL, json=_body(categoryId=None, initialStock=4), headers=h)
        assert res.status_code == 200
        out = res.json()
        assert out["item"]["id"] == "NEW1" and out["item"]["stockQty"] is None
        assert len(out["warnings"]) == 1 and "initial stock" in out["warnings"][0]
        assert stock.call_count == 1
        assert _audit(client, h)[0]["status"] == "partial"


def test_thresholds_roundtrip_and_clear(api: TestClient) -> None:
    h = _key(api, create=False)
    assert api.get("/locations/default/thresholds").status_code == 401
    assert api.get("/locations/default/thresholds", headers=h).json() == {"items": {}, "categories": {}}
    api.put("/locations/default/thresholds/item/ITEM_RICE20", json={"threshold": 10}, headers=h)
    res = api.put("/locations/default/thresholds/category/CAT_RICE", json={"threshold": 4}, headers=h)
    assert res.json() == {"items": {"ITEM_RICE20": 10}, "categories": {"CAT_RICE": 4}}
    # Another device sees it.
    h2 = _key(api, create=False, name="Back")
    assert api.get("/locations/default/thresholds", headers=h2).json()["items"] == {"ITEM_RICE20": 10}
    api.put("/locations/default/thresholds/item/ITEM_RICE20", json={"threshold": None}, headers=h2)
    assert api.get("/locations/default/thresholds", headers=h).json()["items"] == {}
    assert api.put("/locations/default/thresholds/item/X", json={"threshold": -1}, headers=h).status_code == 422
    assert api.put("/locations/default/thresholds/shelf/X", json={"threshold": 1}, headers=h).status_code == 422
    assert api.get("/locations/nowhere/thresholds", headers=h).status_code == 404
    # Never touches Clover.
    assert "lowStockThreshold" not in str(_mock(api).items["ITEM_RICE20"])
