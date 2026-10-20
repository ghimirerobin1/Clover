"""Proxy-side performance baseline in mock mode (spec §6), in-process (no real network or Clover).

    PYTHONPATH=. uv run python scripts/perf_proxy.py

Measures: full catalog paging of 10,000 items through the proxy (incl. the 8 req/s token bucket),
single fresh item read, and the read-verify-write stock write. Clover's real latency is NOT included.
"""

from __future__ import annotations

import json
import statistics
import tempfile
import time
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import AppFactory
from app.mock import MockClover


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        settings = Settings.model_validate({"clover_mock": True, "database_path": str(Path(tmp) / "perf.sqlite3")})
        with TestClient(AppFactory.create(settings)) as api:
            mock: MockClover = api.app.state.mock_clover  # type: ignore[attr-defined]
            for i in range(10_000):
                mock.items[f"P{i:05d}"] = {
                    "id": f"P{i:05d}",
                    "name": f"Perf item {i}",
                    "price": 199,
                    "modifiedTime": 1_700_000_000_000 + i,
                    "itemStock": {"quantity": 50},
                }
            svc = api.app.state.pairing  # type: ignore[attr-defined]
            h = {"X-App-Key": svc.redeem(svc.issue_code().code, "perf").app_key}

            t0 = time.perf_counter()
            offset, fetched = 0, 0
            while True:
                page = api.get("/locations/default/items", params={"limit": 1000, "offset": offset}, headers=h).json()
                fetched += len(page["items"])
                offset += 1000
                if not page["hasMore"]:
                    break
            full_ms = (time.perf_counter() - t0) * 1000

            reads = []
            for i in range(50):
                t = time.perf_counter()
                api.get(f"/locations/default/items/P{i:05d}", headers=h)
                reads.append((time.perf_counter() - t) * 1000)

            writes = []
            for i in range(50):
                t = time.perf_counter()
                r = api.post(
                    f"/locations/default/stock/P{i:05d}",
                    headers=h,
                    json={
                        "expectedQuantity": 50,
                        "newQuantity": 51,
                        "action": "receive",
                        "clientMutationId": str(uuid.uuid4()),
                    },
                )
                assert r.status_code == 200, r.text
                writes.append((time.perf_counter() - t) * 1000)

    def q(xs: list[float]) -> dict[str, float]:
        xs = sorted(xs)
        return {"p50Ms": round(statistics.median(xs), 1), "p95Ms": round(xs[int(len(xs) * 0.95) - 1], 1)}

    print(
        json.dumps(
            {
                "fullCatalog10kThroughProxyMs": round(full_ms),
                "itemsFetched": fetched,
                "freshItemRead": q(reads),
                "stockWriteReadVerifyWrite": q(writes),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
