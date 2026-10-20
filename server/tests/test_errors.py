from __future__ import annotations

import httpx
import pytest

from app.errors import ErrorCode, ErrorMapper


@pytest.mark.parametrize(
    ("status", "code", "retryable_get", "http_status"),
    [
        (400, ErrorCode.VALIDATION, False, 422),
        (401, ErrorCode.AUTH, False, 502),
        (403, ErrorCode.AUTH, False, 502),
        (404, ErrorCode.NOT_FOUND, False, 404),
        (409, ErrorCode.CONFLICT, False, 409),
        (422, ErrorCode.VALIDATION, False, 422),
        (429, ErrorCode.RATE_LIMITED, True, 429),
        (500, ErrorCode.UPSTREAM, True, 502),
        (503, ErrorCode.UPSTREAM, True, 502),
        (418, ErrorCode.UPSTREAM, False, 502),
    ],
)
def test_status_mapping(status: int, code: ErrorCode, retryable_get: bool, http_status: int) -> None:
    err = ErrorMapper.from_status(status, is_write=False)
    assert err.code is code
    assert err.retryable is retryable_get
    assert err.http_status == http_status


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_writes_are_never_marked_retryable(status: int) -> None:
    assert ErrorMapper.from_status(status, is_write=True).retryable is False


def test_transport_errors() -> None:
    exc = httpx.ConnectError("boom")
    get_err = ErrorMapper.from_transport(exc, is_write=False)
    write_err = ErrorMapper.from_transport(exc, is_write=True)
    assert get_err.code is ErrorCode.UPSTREAM and get_err.retryable is True
    assert write_err.code is ErrorCode.UPSTREAM and write_err.retryable is False
    assert "unknown" in write_err.message


def test_body_shape() -> None:
    body = ErrorMapper.from_status(404, is_write=False, detail="Item missing").to_body()
    assert body == {"error": {"code": "NOT_FOUND", "message": "Not found in Clover: Item missing", "retryable": False}}
