from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.clover import CloverClient
from app.config import LocationConfig, Settings
from app.db import Database
from app.idempotency import IdempotencyStore
from app.main import AppFactory
from app.pairing import PairingService
from app.ratelimit import TokenBucket

BASE = "https://clover.test"
MERCHANT = "TESTMERCHANT"


class Sleeps:
    """Records requested sleeps instead of sleeping."""

    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


@pytest.fixture
def db(tmp_path: Path) -> Database:
    database = Database(str(tmp_path / "test.sqlite3"))
    database.migrate()
    return database


@pytest.fixture
def idem(db: Database) -> IdempotencyStore:
    return IdempotencyStore(db)


@pytest.fixture
def pairing(db: Database) -> PairingService:
    return PairingService(db, code_ttl_sec=600)


@pytest.fixture
def sleeps() -> Sleeps:
    return Sleeps()


@pytest.fixture
async def clover(sleeps: Sleeps) -> AsyncIterator[CloverClient]:
    client = CloverClient(
        LocationConfig("default", MERCHANT, "secret-token"),
        base_url=BASE,
        limiter=TokenBucket(1000, 1000),
        max_get_attempts=4,
        sleep=sleeps,
        rng=lambda: 0.0,
    )
    yield client
    await client.aclose()


def make_settings(tmp_path: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {"clover_mock": True, "database_path": str(tmp_path / "api.sqlite3")}
    values.update(overrides)
    # model_validate avoids reading a developer's local .env during tests.
    return Settings.model_validate(values)


@pytest.fixture
def api(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(AppFactory.create(make_settings(tmp_path))) as client:
        yield client


__all__ = ["BASE", "MERCHANT", "Sleeps", "httpx", "make_settings"]
