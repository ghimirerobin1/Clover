from __future__ import annotations

import httpx
import pytest
import respx

from app.clover import CloverClient, RetryPolicy, WriteResult
from app.errors import ApiError, ErrorCode
from app.idempotency import IdempotencyStore

from .conftest import BASE, MERCHANT, Sleeps

ITEMS = f"{BASE}/v3/merchants/{MERCHANT}/items"
STOCK = f"{BASE}/v3/merchants/{MERCHANT}/item_stocks/ITEM1"


@respx.mock
async def test_get_sends_bearer_token_and_merchant_path(clover: CloverClient) -> None:
    route = respx.get(ITEMS).mock(return_value=httpx.Response(200, json={"elements": []}))
    assert await clover.get("/items", {"limit": 10}) == {"elements": []}
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Bearer secret-token"
    assert req.url.params["limit"] == "10"


@respx.mock
async def test_get_retries_429_honoring_retry_after(clover: CloverClient, sleeps: Sleeps) -> None:
    route = respx.get(ITEMS).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "2"}),
            httpx.Response(429),
            httpx.Response(200, json={"elements": [1]}),
        ]
    )
    assert await clover.get("/items") == {"elements": [1]}
    assert route.call_count == 3
    assert sleeps.calls[0] == 2.0  # Retry-After honored as a floor
    assert len(sleeps.calls) == 2


@respx.mock
async def test_get_gives_up_after_max_attempts(clover: CloverClient, sleeps: Sleeps) -> None:
    route = respx.get(ITEMS).mock(return_value=httpx.Response(429))
    with pytest.raises(ApiError) as ei:
        await clover.get("/items")
    assert route.call_count == 4
    assert len(sleeps.calls) == 3
    assert ei.value.code is ErrorCode.RATE_LIMITED and ei.value.retryable


@respx.mock
async def test_get_does_not_retry_other_errors(clover: CloverClient) -> None:
    route = respx.get(ITEMS).mock(return_value=httpx.Response(500))
    with pytest.raises(ApiError) as ei:
        await clover.get("/items")
    assert route.call_count == 1
    assert ei.value.code is ErrorCode.UPSTREAM


@respx.mock
async def test_get_maps_404_with_detail(clover: CloverClient) -> None:
    respx.get(ITEMS).mock(return_value=httpx.Response(404, json={"message": "nope"}))
    with pytest.raises(ApiError) as ei:
        await clover.get("/items")
    assert ei.value.code is ErrorCode.NOT_FOUND
    assert "nope" in ei.value.message


@respx.mock
async def test_get_transport_error_is_upstream_retryable(clover: CloverClient) -> None:
    respx.get(ITEMS).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(ApiError) as ei:
        await clover.get("/items")
    assert ei.value.code is ErrorCode.UPSTREAM and ei.value.retryable


async def _write(clover: CloverClient, idem: IdempotencyStore, cmid: str = "m1", qty: int = 5) -> WriteResult:
    return await clover.write(
        "POST", "/item_stocks/ITEM1", {"quantity": qty}, idempotency=idem, device_id="dev1", client_mutation_id=cmid
    )


@respx.mock
async def test_write_429_is_not_retried(clover: CloverClient, idem: IdempotencyStore, sleeps: Sleeps) -> None:
    route = respx.post(STOCK).mock(return_value=httpx.Response(429))
    with pytest.raises(ApiError) as ei:
        await _write(clover, idem)
    assert route.call_count == 1
    assert sleeps.calls == []
    assert ei.value.code is ErrorCode.RATE_LIMITED and ei.value.retryable is False
    # Definitely not applied -> the same id may be re-confirmed later.
    route.mock(return_value=httpx.Response(200, json={"quantity": 5}))
    result = await _write(clover, idem)
    assert result.replayed is False


@respx.mock
async def test_write_replay_does_not_call_clover_twice(clover: CloverClient, idem: IdempotencyStore) -> None:
    route = respx.post(STOCK).mock(return_value=httpx.Response(200, json={"quantity": 5}))
    first = await _write(clover, idem)
    second = await _write(clover, idem)
    assert route.call_count == 1
    assert first.replayed is False and second.replayed is True
    assert second.body == {"quantity": 5}


@respx.mock
async def test_write_transport_error_leaves_unknown_state(clover: CloverClient, idem: IdempotencyStore) -> None:
    route = respx.post(STOCK).mock(side_effect=httpx.ReadTimeout("lost"))
    with pytest.raises(ApiError) as ei:
        await _write(clover, idem)
    assert ei.value.retryable is False
    # Blind retry with same id is refused; Clover is not called again.
    with pytest.raises(ApiError) as again:
        await _write(clover, idem)
    assert again.value.code is ErrorCode.CONFLICT
    assert route.call_count == 1


@respx.mock
async def test_write_4xx_is_stored_and_replayed_as_error(clover: CloverClient, idem: IdempotencyStore) -> None:
    route = respx.post(STOCK).mock(return_value=httpx.Response(400, json={"message": "bad qty"}))
    for _ in range(2):
        with pytest.raises(ApiError) as ei:
            await _write(clover, idem)
        assert ei.value.code is ErrorCode.VALIDATION
    assert route.call_count == 1


@respx.mock
async def test_write_reused_id_with_different_body_conflicts(clover: CloverClient, idem: IdempotencyStore) -> None:
    respx.post(STOCK).mock(return_value=httpx.Response(200, json={"quantity": 5}))
    await _write(clover, idem, qty=5)
    with pytest.raises(ApiError) as ei:
        await _write(clover, idem, qty=6)
    assert ei.value.code is ErrorCode.CONFLICT


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("", None), ("3", 3.0), ("1.5", 1.5), ("-4", 0.0), ("999", 30.0), ("garbage", None)],
)
def test_parse_retry_after(value: str | None, expected: float | None) -> None:
    assert RetryPolicy.parse_retry_after(value) == expected


def test_backoff_grows_and_is_capped() -> None:
    delays = [RetryPolicy.delay(n, None, rng=lambda: 1.0) for n in range(10)]
    assert delays[:3] == [0.5, 1.0, 2.0]
    assert max(delays) == 30.0
    assert RetryPolicy.delay(0, 5.0, rng=lambda: 0.0) == 5.0
