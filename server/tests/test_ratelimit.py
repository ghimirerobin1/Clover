from __future__ import annotations

from app.ratelimit import TokenBucket


async def test_bucket_throttles_after_burst() -> None:
    now = [0.0]
    slept: list[float] = []

    async def fake_sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    bucket = TokenBucket(8, 2, clock=lambda: now[0], sleep=fake_sleep)
    for _ in range(4):
        await bucket.acquire()
    assert slept == [0.125, 0.125]
