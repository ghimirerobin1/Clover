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

URL = "/locations/default/stock/ITEM_RICE20"


def _key(client: TestClient, name: str = "Front") -> dict[str, str]:
    service: PairingService = client.app.state.pairing  # type: ignore[attr-defined]
    return {"X-App-Key": service.redeem(service.issue_code().code, name).app_key}


def _body(expected: float, new: float, action: str = "receive", **extra: Any) -> dict[str, Any]:
    return {
        "expectedQuantity": expected,
        "newQuantity": new,
        "action": action,
        "clientMutationId": extra.pop("cmid", str(uuid.uuid4())),
        **extra,
    }


def _mock(api: TestClient) -> MockClover:
    return api.app.state.mock_clover  # type: ignore[attr-defined, no-any-return]


def _audit(api: TestClient, h: dict[str, str], **params: Any) -> list[dict[str, Any]]:
    res = api.get("/locations/default/audit", params=params, headers=h)
    assert res.status_code == 200
    entries: list[dict[str, Any]] = res.json()["entries"]
    return entries


def test_requires_key(api: TestClient) -> None:
    assert api.post(URL, json=_body(14, 38)).status_code == 401
    assert api.get("/locations/default/audit").status_code == 401


def test_applies_when_expected_matches_and_audits(api: TestClient) -> None:
    h = _key(api)
    res = api.post(URL, json=_body(14, 38, note="INV-1001"), headers=h)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["previousQuantity"] == 14 and body["newQuantity"] == 38 and body["replayed"] is False
    assert _mock(api).items["ITEM_RICE20"]["itemStock"]["quantity"] == 38
    [entry] = _audit(api, h)
    assert entry["id"] == body["auditId"]
    assert entry["itemName"] == "Jasmine Rice 20lb"
    assert (entry["beforeQty"], entry["afterQty"], entry["action"], entry["status"]) == (14, 38, "receive", "applied")
    assert entry["note"] == "INV-1001" and entry["deviceName"] == "Front"


def test_conflict_returns_live_value_and_does_not_write(api: TestClient) -> None:
    h = _key(api)
    _mock(api).items["ITEM_RICE20"]["itemStock"]["quantity"] = 12  # a sale happened
    res = api.post(URL, json=_body(14, 38), headers=h)
    assert res.status_code == 409
    err = res.json()["error"]
    assert err["code"] == "CONFLICT" and err["currentQuantity"] == 12 and err["retryable"] is False
    assert _mock(api).items["ITEM_RICE20"]["itemStock"]["quantity"] == 12
    assert _audit(api, h)[0]["status"] == "conflict"


def test_replay_returns_original_result_without_second_write(api: TestClient) -> None:
    h = _key(api)
    req = _body(14, 38, cmid="cmid-replay-0001")
    first = api.post(URL, json=req, headers=h).json()
    # Stock moves on afterwards; the replay must NOT re-write or 409, it returns the stored result.
    _mock(api).items["ITEM_RICE20"]["itemStock"]["quantity"] = 30
    second = api.post(URL, json=req, headers=h).json()
    assert second["replayed"] is True and second["auditId"] == first["auditId"]
    assert _mock(api).items["ITEM_RICE20"]["itemStock"]["quantity"] == 30
    assert len(_audit(api, h)) == 1


def test_replayed_conflict_is_still_a_conflict(api: TestClient) -> None:
    h = _key(api)
    _mock(api).items["ITEM_RICE20"]["itemStock"]["quantity"] = 12
    req = _body(14, 38, cmid="cmid-conflict-01")
    assert api.post(URL, json=req, headers=h).status_code == 409
    again = api.post(URL, json=req, headers=h)
    assert again.status_code == 409 and again.json()["error"]["currentQuantity"] == 12


def test_reused_id_with_different_body_conflicts(api: TestClient) -> None:
    h = _key(api)
    api.post(URL, json=_body(14, 38, cmid="cmid-reuse-0001"), headers=h)
    res = api.post(URL, json=_body(38, 40, cmid="cmid-reuse-0001"), headers=h)
    assert res.status_code == 409 and "currentQuantity" not in res.json()["error"]


def test_ids_are_per_device(api: TestClient) -> None:
    a, b = _key(api, "A"), _key(api, "B")
    assert api.post(URL, json=_body(14, 20, cmid="cmid-shared-001"), headers=a).status_code == 200
    assert api.post(URL, json=_body(20, 25, cmid="cmid-shared-001"), headers=b).status_code == 200


def test_validation(api: TestClient) -> None:
    h = _key(api)
    for bad in (
        _body(14, -1),
        _body(14, 38, action="explode"),
        _body(14, 38, cmid="short"),
        {"newQuantity": 1, "action": "count", "clientMutationId": "cmid-0000001"},
        _body(14, 10, action="adjust"),  # adjust needs a reason
    ):
        res = api.post(URL, json=bad, headers=h)
        assert res.status_code == 422 and res.json()["error"]["code"] == "VALIDATION", bad
    assert api.post(URL, json=_body(14, 10, action="adjust", reason="damaged"), headers=h).status_code == 200


def test_untracked_and_missing_items(api: TestClient) -> None:
    h = _key(api)
    res = api.post("/locations/default/stock/ITEM_NOSTOCK", json=_body(0, 5), headers=h)
    assert res.status_code == 422
    res = api.post("/locations/default/stock/NOPE", json=_body(0, 5), headers=h)
    assert res.status_code == 404
    # Failed reads release the id: the same id can be used once the problem is fixed.
    assert _audit(api, h) == []


def test_audit_feed_filters_and_pagination(api: TestClient) -> None:
    h = _key(api)
    api.post(URL, json=_body(14, 20), headers=h)
    api.post(URL, json=_body(20, 18, action="adjust", reason="damaged"), headers=h)
    api.post("/locations/default/stock/ITEM_RAMEN", json=_body(3, 10, action="count"), headers=h)
    assert [e["itemId"] for e in _audit(api, h, itemId="ITEM_RICE20")] == ["ITEM_RICE20", "ITEM_RICE20"]
    assert [e["action"] for e in _audit(api, h, action="count")] == ["count"]
    page = api.get("/locations/default/audit", params={"limit": 2}, headers=h).json()
    assert len(page["entries"]) == 2 and page["nextBefore"] is not None
    rest = api.get("/locations/default/audit", params={"limit": 2, "before": page["nextBefore"]}, headers=h).json()
    assert len(rest["entries"]) == 1 and rest["nextBefore"] is None
    assert _audit(api, h, since="2999-01-01T00:00:00") == []
    assert api.get("/locations/store-2/audit", headers=h).status_code == 404


def _real(tmp_path: Path) -> TestClient:
    settings = make_settings(
        tmp_path, clover_mock=False, clover_api_token="t", clover_merchant_id="M1", clover_base_url="https://c.test"
    )
    return TestClient(AppFactory.create(settings))


ITEM = {"id": "I1", "name": "Rice", "price": 100, "modifiedTime": 1, "itemStock": {"quantity": 5}}


@respx.mock
def test_transport_failure_after_send_is_unknown_and_not_retried(tmp_path: Path) -> None:
    respx.get("https://c.test/v3/merchants/M1/items/I1").mock(return_value=httpx.Response(200, json=ITEM))
    post = respx.post("https://c.test/v3/merchants/M1/item_stocks/I1").mock(side_effect=httpx.ReadTimeout("lost"))
    with _real(tmp_path) as client:
        h = _key(client)
        req = _body(5, 9, cmid="cmid-unknown-01")
        res = client.post("/locations/default/stock/I1", json=req, headers=h)
        assert res.status_code == 502
        assert res.json()["error"]["retryable"] is False
        assert "unknown" in res.json()["error"]["message"]
        # Same id again: refused, Clover not called a second time.
        again = client.post("/locations/default/stock/I1", json=req, headers=h)
        assert again.status_code == 409
        assert post.call_count == 1
        [entry] = _audit(client, h)
        assert entry["status"] == "unknown"


@respx.mock
def test_clover_5xx_on_write_is_unknown(tmp_path: Path) -> None:
    respx.get("https://c.test/v3/merchants/M1/items/I1").mock(return_value=httpx.Response(200, json=ITEM))
    respx.post("https://c.test/v3/merchants/M1/item_stocks/I1").mock(return_value=httpx.Response(503))
    with _real(tmp_path) as client:
        h = _key(client)
        res = client.post("/locations/default/stock/I1", json=_body(5, 9), headers=h)
        assert res.status_code == 502 and res.json()["error"]["retryable"] is False
        assert _audit(client, h)[0]["status"] == "unknown"


@respx.mock
def test_clover_429_on_write_frees_id(tmp_path: Path) -> None:
    respx.get("https://c.test/v3/merchants/M1/items/I1").mock(return_value=httpx.Response(200, json=ITEM))
    post = respx.post("https://c.test/v3/merchants/M1/item_stocks/I1").mock(
        side_effect=[httpx.Response(429), httpx.Response(200, json={"quantity": 9})]
    )
    with _real(tmp_path) as client:
        h = _key(client)
        req = _body(5, 9, cmid="cmid-429-00001")
        assert client.post("/locations/default/stock/I1", json=req, headers=h).status_code == 429
        res = client.post("/locations/default/stock/I1", json=req, headers=h)
        assert res.status_code == 200 and res.json()["newQuantity"] == 9
        assert post.call_count == 2
        assert [e["status"] for e in _audit(client, h)] == ["applied", "rejected"]


@respx.mock
def test_write_body_is_absolute_quantity(tmp_path: Path) -> None:
    respx.get("https://c.test/v3/merchants/M1/items/I1").mock(return_value=httpx.Response(200, json=ITEM))
    post = respx.post("https://c.test/v3/merchants/M1/item_stocks/I1").mock(
        return_value=httpx.Response(200, json={"quantity": 9})
    )
    with _real(tmp_path) as client:
        client.post("/locations/default/stock/I1", json=_body(5, 9), headers=_key(client))
    assert post.calls.last.request.content == b'{"quantity":9}'


def test_audit_migration_adds_columns(tmp_path: Path) -> None:
    import sqlite3

    from app.db import SCHEMA, Database

    path = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)  # M1 schema without the new columns
    conn.close()
    Database(str(path)).migrate()
    Database(str(path)).migrate()  # idempotent
    cols = {r[1] for r in sqlite3.connect(path).execute("PRAGMA table_info(audit_log)")}
    assert {"item_name", "note", "status"} <= cols
