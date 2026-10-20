from __future__ import annotations

import pytest

from app.errors import ApiError, ErrorCode
from app.idempotency import IdempotencyStore


def test_first_begin_proceeds_then_replays(idem: IdempotencyStore) -> None:
    h = IdempotencyStore.request_hash("POST", "/x", {"a": 1})
    assert idem.begin("dev", "m1", h) is None
    idem.complete("dev", "m1", 200, {"quantity": 3})
    replay = idem.begin("dev", "m1", h)
    assert replay is not None and replay.status_code == 200 and replay.body == {"quantity": 3}


def test_pending_blocks_concurrent_or_unknown(idem: IdempotencyStore) -> None:
    h = IdempotencyStore.request_hash("POST", "/x", {})
    idem.begin("dev", "m1", h)
    with pytest.raises(ApiError) as ei:
        idem.begin("dev", "m1", h)
    assert ei.value.code is ErrorCode.CONFLICT


def test_release_frees_id(idem: IdempotencyStore) -> None:
    h = IdempotencyStore.request_hash("POST", "/x", {})
    idem.begin("dev", "m1", h)
    idem.release("dev", "m1")
    assert idem.begin("dev", "m1", h) is None


def test_ids_are_scoped_per_device(idem: IdempotencyStore) -> None:
    h = IdempotencyStore.request_hash("POST", "/x", {})
    assert idem.begin("devA", "m1", h) is None
    assert idem.begin("devB", "m1", h) is None


def test_hash_is_order_insensitive() -> None:
    assert IdempotencyStore.request_hash("post", "/x", {"a": 1, "b": 2}) == IdempotencyStore.request_hash(
        "POST", "/x", {"b": 2, "a": 1}
    )


@pytest.mark.parametrize("cmid", ["", "x" * 129])
def test_rejects_bad_ids(idem: IdempotencyStore, cmid: str) -> None:
    with pytest.raises(ApiError) as ei:
        idem.begin("dev", cmid, "h")
    assert ei.value.code is ErrorCode.VALIDATION
