"""End-to-end smoke test against a running proxy in mock mode (CLOVER_MOCK=1).

Drives the real HTTP API the app uses: pairing, receive, count, adjust, a forced 409 (a second device
changes stock between read and write), an idempotent retry, and a sequential batch with mixed results.

    CLOVER_MOCK=1 DATABASE_PATH=/tmp/e2e.sqlite3 uv run uvicorn app.main:app --port 8765 &
    CLOVER_MOCK=1 DATABASE_PATH=/tmp/e2e.sqlite3 uv run python scripts/e2e_mock.py --base http://127.0.0.1:8765

Also covers gated item creation (off → 403, on → created, replay idempotent) and shared thresholds.

Exits non-zero on the first failed check. Only ever talks to the mock (refuses if /health says mock=false).
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import uuid
from typing import Any

import httpx

LOC = "default"


class E2E:
    def __init__(self, base: str) -> None:
        self.http = httpx.Client(base_url=base, timeout=10)
        self.passed = 0

    def check(self, name: str, ok: bool, detail: Any = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  — {detail}' if detail != '' else ''}")
        if not ok:
            sys.exit(1)
        self.passed += 1

    @staticmethod
    def issue_code(*, allow_create: bool = False) -> str:
        argv = [sys.executable, "-m", "app.pair"] + (["--allow-create-items"] if allow_create else [])
        out = subprocess.run(  # noqa: S603 - fixed argv, our own CLI
            argv, check=True, capture_output=True, text=True, env=os.environ.copy()
        ).stdout
        m = re.search(r"Pairing code:\s*(\w{4}) (\w{4})", out)
        if not m:
            raise RuntimeError(f"unexpected pair output: {out!r}")
        return m.group(1) + m.group(2)

    def pair(self, name: str, *, allow_create: bool = False) -> dict[str, str]:
        r = self.http.post("/pair", json={"code": self.issue_code(allow_create=allow_create), "deviceName": name})
        self.check(f"pair {name}", r.status_code == 200, r.status_code)
        return {"X-App-Key": r.json()["appKey"]}

    def live(self, key: dict[str, str], item: str) -> int:
        r = self.http.get(f"/locations/{LOC}/items/{item}", headers=key)
        r.raise_for_status()
        return int(r.json()["stockQty"])

    def write(self, key: dict[str, str], item: str, body: dict[str, Any]) -> httpx.Response:
        return self.http.post(f"/locations/{LOC}/stock/{item}", headers=key, json=body)

    def confirmed(
        self, key: dict[str, str], item: str, action: str, target: Any, *, reason: str | None = None
    ) -> httpx.Response:
        """App protocol: fresh read → before/after → one write with a new mutation id."""
        before = self.live(key, item)
        new = target(before) if callable(target) else target
        body: dict[str, Any] = {
            "expectedQuantity": before,
            "newQuantity": new,
            "action": action,
            "clientMutationId": str(uuid.uuid4()),
        }
        if reason:
            body["reason"] = reason
        return self.write(key, item, body)

    def run(self) -> None:
        h = self.http.get("/health").json()
        self.check("health (mock mode)", h.get("mock") is True, h)
        a = self.pair("e2e-phone-A")
        b = self.pair("e2e-phone-B")
        self.check("no key → 401", self.http.get("/me").status_code == 401)

        # Receive +24 on 14 → 38
        r = self.confirmed(a, "ITEM_RICE20", "receive", lambda q: q + 24)
        j = r.json()
        self.check("receive +24", r.status_code == 200 and (j["previousQuantity"], j["newQuantity"]) == (14, 38), j)
        self.check("receive persisted", self.live(a, "ITEM_RICE20") == 38)

        # Count set to 10 on POCKY
        r = self.confirmed(a, "ITEM_POCKY", "count", 10)
        self.check("count → 10", r.status_code == 200 and r.json()["newQuantity"] == 10, r.json())

        # Adjust −2 Damaged on PORKBELLY (8 → 6); adjust without reason is rejected
        r = self.confirmed(a, "ITEM_PORKBELLY", "adjust", lambda q: q - 2, reason="damaged")
        self.check("adjust −2 damaged", r.status_code == 200 and r.json()["newQuantity"] == 6, r.json())
        r = self.confirmed(a, "ITEM_PORKBELLY", "adjust", lambda q: q - 1)
        self.check("adjust without reason → 422", r.status_code == 422, r.json()["error"]["code"])
        self.check("…and nothing written", self.live(a, "ITEM_PORKBELLY") == 6)

        # Forced 409: A reads RAMEN (3), B sells/adjusts it to 2, A writes with the stale base.
        stale = self.live(a, "ITEM_RAMEN")
        rb = self.confirmed(b, "ITEM_RAMEN", "adjust", lambda q: q - 1, reason="theft_loss")
        self.check("device B changes RAMEN", rb.status_code == 200, rb.json())
        r = self.write(
            a,
            "ITEM_RAMEN",
            {
                "expectedQuantity": stale,
                "newQuantity": stale + 24,
                "action": "receive",
                "clientMutationId": str(uuid.uuid4()),
            },
        )
        err = r.json()["error"]
        self.check(
            "stale write → 409 with live value",
            r.status_code == 409 and err["code"] == "CONFLICT" and err["currentQuantity"] == 2,
            err,
        )
        self.check("409 wrote nothing", self.live(a, "ITEM_RAMEN") == 2)
        # Re-confirm (Receive recomputes from the new base): 2 + 24 = 26
        r = self.confirmed(a, "ITEM_RAMEN", "receive", lambda q: q + 24)
        self.check("re-confirm after 409 → 26", r.status_code == 200 and r.json()["newQuantity"] == 26, r.json())

        # Idempotent retry: identical request twice → second is a replay, applied once.
        before = self.live(a, "ITEM_FISHSAUCE")
        body = {
            "expectedQuantity": before,
            "newQuantity": before + 6,
            "action": "receive",
            "clientMutationId": str(uuid.uuid4()),
        }
        r1 = self.write(a, "ITEM_FISHSAUCE", body)
        r2 = self.write(a, "ITEM_FISHSAUCE", body)
        self.check("first send applied", r1.status_code == 200 and r1.json()["replayed"] is False, r1.json())
        self.check(
            "retry replayed, same audit id",
            r2.status_code == 200 and r2.json()["replayed"] is True and r2.json()["auditId"] == r1.json()["auditId"],
            r2.json(),
        )
        self.check("applied exactly once", self.live(a, "ITEM_FISHSAUCE") == before + 6)
        r3 = self.write(a, "ITEM_FISHSAUCE", {**body, "newQuantity": before + 7})
        self.check("same id, different body → 409", r3.status_code == 409, r3.json()["error"]["code"])
        r4 = self.write(b, "ITEM_FISHSAUCE", body)
        self.check(
            "same id from another device is independent (→ 409 stale base)", r4.status_code == 409, r4.json()["error"]
        )

        # Batch (continuous scan → Review & apply): live reads first, then strictly sequential writes.
        tally = [
            ("ITEM_RICE20", "count", 20),
            ("ITEM_POCKY", "receive", 5),
            ("ITEM_NOSTOCK", "count", 3),
            ("ITEM_RAMEN", "count", 30),
        ]
        bases: dict[str, int | None] = {}
        for item, _, _ in tally:
            r = self.http.get(f"/locations/{LOC}/items/{item}", headers=a)
            bases[item] = r.json()["stockQty"]
        # A sale lands on RAMEN after the confirmation screen was shown.
        self.confirmed(b, "ITEM_RAMEN", "adjust", lambda q: q - 1, reason="other")
        results: list[tuple[str, int, str]] = []
        for item, action, qty in tally:
            base = bases[item]
            new = qty if action == "count" else (base or 0) + qty
            r = self.write(
                a,
                item,
                {
                    "expectedQuantity": base if base is not None else 0,
                    "newQuantity": new,
                    "action": action,
                    "clientMutationId": str(uuid.uuid4()),
                },
            )
            code = r.json().get("error", {}).get("code", "OK")
            results.append((item, r.status_code, code))
        print("      batch results:", results)
        self.check(
            "batch per-row results",
            [s for _, s, _ in results] == [200, 200, 422, 409],
            results,
        )
        # Retry only the conflicting row, Count keeps its absolute 30.
        r = self.confirmed(a, "ITEM_RAMEN", "count", 30)
        self.check(
            "batch conflict re-confirmed (Count keeps 30)",
            r.status_code == 200 and r.json()["newQuantity"] == 30,
            r.json(),
        )

        # Audit feed
        r = self.http.get(f"/locations/{LOC}/audit", headers=a, params={"limit": 100})
        entries = r.json()["entries"]
        statuses: dict[str, int] = {}
        for e in entries:
            statuses[e["status"]] = statuses.get(e["status"], 0) + 1
        self.check("audit feed lists all devices", {e["deviceName"] for e in entries} >= {"e2e-phone-A", "e2e-phone-B"})
        self.check("audit records conflicts", statuses.get("conflict", 0) >= 3, statuses)
        fish = [e for e in entries if e["itemId"] == "ITEM_FISHSAUCE" and e["status"] == "applied"]
        self.check("idempotent retry audited once", len(fish) == 1, len(fish))
        r = self.http.get(f"/locations/{LOC}/audit", headers=a, params={"itemId": "ITEM_RAMEN", "action": "receive"})
        self.check(
            "audit filter itemId+action",
            all(e["itemId"] == "ITEM_RAMEN" and e["action"] == "receive" for e in r.json()["entries"]),
        )
        self.create_items(a)
        self.thresholds(a, b)
        print(f"\nAll {self.passed} checks passed. Audit statuses: {statuses}")

    def create_items(self, plain: dict[str, str]) -> None:
        body: dict[str, Any] = {
            "name": "E2E Mango Lassi",
            "priceCents": 349,
            "code": "012345678905",
            "sku": "E2E-LASSI",
            "categoryId": "CAT_SNACK",
            "initialStock": 12,
            "clientMutationId": str(uuid.uuid4()),
        }
        url = f"/locations/{LOC}/items"
        me = self.http.get("/me", headers=plain).json()
        self.check("plain device has canCreateItems=false", me["canCreateItems"] is False, me)
        r = self.http.post(url, headers=plain, json=body)
        self.check(
            "create gated off → 403 AUTH", r.status_code == 403 and r.json()["error"]["code"] == "AUTH", r.json()
        )
        lookup = self.http.get(
            f"/locations/{LOC}/items/lookup", headers=plain, params={"code": str(body["code"])}
        ).json()
        self.check("…and nothing was created", lookup["match"] is None and lookup["candidates"] == [], lookup)

        c = self.pair("e2e-manager", allow_create=True)
        self.check("manager has canCreateItems=true", self.http.get("/me", headers=c).json()["canCreateItems"] is True)
        r1 = self.http.post(url, headers=c, json=body)
        out = r1.json()
        item = out.get("item", {})
        self.check(
            "create gated on → created",
            r1.status_code == 200
            and item.get("priceCents") == 349
            and item.get("stockQty") == 12
            and out["warnings"] == [],
            out,
        )
        self.check("created item has its category", item.get("categoryId") == "CAT_SNACK", item)
        r2 = self.http.post(url, headers=c, json=body)
        self.check(
            "create replay is idempotent (same id, replayed)",
            r2.status_code == 200 and r2.json()["replayed"] is True and r2.json()["item"]["id"] == item["id"],
            r2.json(),
        )
        found = self.http.get(
            f"/locations/{LOC}/items/lookup", headers=plain, params={"code": str(body["code"])}
        ).json()
        self.check("exactly one item exists for the UPC", (found["match"] or {}).get("id") == item["id"], found)
        r3 = self.http.post(url, headers=c, json={**body, "name": "Changed"})
        self.check("same id, different body → 409", r3.status_code == 409, r3.json()["error"]["code"])
        bad = self.http.post(url, headers=c, json={**body, "priceCents": 3.49, "clientMutationId": str(uuid.uuid4())})
        self.check("float price rejected (money is integer cents)", bad.status_code == 422)
        creates = [
            e
            for e in self.http.get(f"/locations/{LOC}/audit", headers=c, params={"limit": 200}).json()["entries"]
            if e["action"] == "create"
        ]
        self.check("create audited once", len(creates) == 1 and creates[0]["itemId"] == item["id"], len(creates))
        # The new item takes part in the normal stock write path.
        r = self.confirmed(c, item["id"], "receive", lambda q: q + 3)
        self.check("receive on the new item", r.status_code == 200 and r.json()["newQuantity"] == 15, r.json())

    def thresholds(self, a: dict[str, str], b: dict[str, str]) -> None:
        base = f"/locations/{LOC}/thresholds"
        self.http.put(f"{base}/item/ITEM_RICE20", headers=a, json={"threshold": 25})
        self.http.put(f"{base}/category/CAT_RICE", headers=a, json={"threshold": 9})
        seen = self.http.get(base, headers=b).json()
        self.check(
            "thresholds shared across devices",
            seen == {"items": {"ITEM_RICE20": 25}, "categories": {"CAT_RICE": 9}},
            seen,
        )
        self.http.put(f"{base}/item/ITEM_RICE20", headers=b, json={"threshold": None})
        self.check("threshold cleared", self.http.get(base, headers=a).json()["items"] == {})


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8765")
    E2E(p.parse_args().base).run()
