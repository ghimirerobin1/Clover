from __future__ import annotations

import sqlite3
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import Database
from app.errors import ApiError, ErrorCode
from app.main import AppFactory
from app.pair import PairCli
from app.pairing import PairingService, PairingThrottle
from app.security import Secrets
from app.timeutil import Clock

from .conftest import make_settings


def test_redeem_issues_key_stored_only_as_hash(pairing: PairingService, db: Database) -> None:
    issued = pairing.issue_code()
    paired = pairing.redeem(issued.code, "Front counter iPhone")
    with db.connect() as conn:
        row = conn.execute("SELECT key_hash FROM devices WHERE id = ?", (paired.device.id,)).fetchone()
        codes = [r[0] for r in conn.execute("SELECT code_hash FROM pairing_codes")]
        dump = "\n".join(conn.iterdump())
    assert row["key_hash"] == Secrets.hash(paired.app_key)
    assert paired.app_key not in dump
    assert issued.code not in dump
    assert codes == [Secrets.hash(issued.code)]
    assert pairing.authenticate(paired.app_key).id == paired.device.id


def test_code_is_single_use(pairing: PairingService) -> None:
    code = pairing.issue_code().code
    pairing.redeem(code, "A")
    with pytest.raises(ApiError) as ei:
        pairing.redeem(code, "B")
    assert ei.value.code is ErrorCode.AUTH


def test_code_expires(pairing: PairingService) -> None:
    code = pairing.issue_code().code
    with pytest.raises(ApiError):
        pairing.redeem(code, "A", now=Clock.now() + timedelta(minutes=11))


def test_code_with_spaces_is_accepted(pairing: PairingService) -> None:
    code = pairing.issue_code().code
    assert pairing.redeem(f"{code[:4]} {code[4:]}", "A").device.name == "A"


def test_create_items_flag_propagates(pairing: PairingService) -> None:
    code = pairing.issue_code(can_create_items=True).code
    assert pairing.redeem(code, "A").device.can_create_items is True


def test_revoked_key_rejected(pairing: PairingService) -> None:
    paired = pairing.redeem(pairing.issue_code().code, "A")
    assert pairing.revoke(paired.device.id)
    with pytest.raises(ApiError):
        pairing.authenticate(paired.app_key)


@pytest.mark.parametrize("key", [None, "", "not-a-key"])
def test_bad_keys_rejected(pairing: PairingService, key: str | None) -> None:
    with pytest.raises(ApiError) as ei:
        pairing.authenticate(key)
    assert ei.value.code is ErrorCode.AUTH


def test_throttle() -> None:
    t = PairingThrottle(2)
    t.record_failure(0)
    t.record_failure(1)
    with pytest.raises(ApiError) as ei:
        t.check(2)
    assert ei.value.code is ErrorCode.RATE_LIMITED
    t.check(62)  # window slid


def test_http_pairing_flow(api: TestClient) -> None:
    service: PairingService = api.app.state.pairing  # type: ignore[attr-defined]
    code = service.issue_code().code
    assert api.get("/me").status_code == 401
    assert api.get("/me").json()["error"]["code"] == "AUTH"

    res = api.post("/pair", json={"code": code, "deviceName": "Back office"})
    assert res.status_code == 200
    key = res.json()["appKey"]
    assert res.json()["device"]["canCreateItems"] is False

    me = api.get("/me", headers={"X-App-Key": key})
    assert me.status_code == 200 and me.json()["name"] == "Back office"

    again = api.post("/pair", json={"code": code, "deviceName": "Other"})
    assert again.status_code == 401


def test_http_pairing_validation_error_shape(api: TestClient) -> None:
    res = api.post("/pair", json={"code": "123"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "VALIDATION"


def test_http_pairing_throttled(tmp_path: Path) -> None:
    app = AppFactory.create(make_settings(tmp_path, pairing_max_failures_per_min=2))
    with TestClient(app) as client:
        for _ in range(2):
            assert client.post("/pair", json={"code": "00000000", "deviceName": "x"}).status_code == 401
        res = client.post("/pair", json={"code": "00000000", "deviceName": "x"})
        assert res.status_code == 429 and res.json()["error"]["code"] == "RATE_LIMITED"


def test_cli_issues_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from app import config

    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "cli.sqlite3"))
    config.get_settings.cache_clear()
    try:
        assert PairCli.run([]) == 0
        out = capsys.readouterr().out
        code = out.split("Pairing code:")[1].split("\n")[0].replace(" ", "")
        assert len(code) == 8 and code.isdigit()
        conn = sqlite3.connect(tmp_path / "cli.sqlite3")
        assert conn.execute("SELECT code_hash FROM pairing_codes").fetchone()[0] == Secrets.hash(code)
        conn.close()
        assert PairCli.run(["--list"]) == 0
    finally:
        config.get_settings.cache_clear()
