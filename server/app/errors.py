"""Stable error shape returned to the app (spec §3):
{"error": {"code": ..., "message": ..., "retryable": ...}}
"""

from __future__ import annotations

from enum import StrEnum

import httpx


class ErrorCode(StrEnum):
    NOT_FOUND = "NOT_FOUND"
    RATE_LIMITED = "RATE_LIMITED"
    CONFLICT = "CONFLICT"
    AUTH = "AUTH"
    UPSTREAM = "UPSTREAM"
    VALIDATION = "VALIDATION"


class ApiError(Exception):
    def __init__(self, code: ErrorCode, message: str, retryable: bool, http_status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.http_status = http_status

    def to_body(self) -> dict[str, dict[str, object]]:
        return {"error": {"code": self.code.value, "message": self.message, "retryable": self.retryable}}


class ErrorMapper:
    """Maps upstream Clover responses / transport failures to ApiError. Pure, unit-tested."""

    @staticmethod
    def from_status(status: int, *, is_write: bool, detail: str | None = None) -> ApiError:
        suffix = f": {detail}" if detail else ""
        if status in (401, 403):
            # Our token is bad/insufficient: a server config problem, surfaced as AUTH, not retryable.
            return ApiError(ErrorCode.AUTH, f"Clover rejected the credentials ({status}){suffix}", False, 502)
        if status == 404:
            return ApiError(ErrorCode.NOT_FOUND, f"Not found in Clover{suffix}", False, 404)
        if status == 409:
            return ApiError(ErrorCode.CONFLICT, f"Conflict reported by Clover{suffix}", False, 409)
        if status == 429:
            # Writes are never auto-retried; the app decides after re-reading.
            return ApiError(ErrorCode.RATE_LIMITED, "Clover rate limit reached; try again shortly", not is_write, 429)
        if status in (400, 422):
            return ApiError(ErrorCode.VALIDATION, f"Clover rejected the request ({status}){suffix}", False, 422)
        if 500 <= status < 600:
            return ApiError(ErrorCode.UPSTREAM, f"Clover error ({status})", not is_write, 502)
        return ApiError(ErrorCode.UPSTREAM, f"Unexpected Clover response ({status})", False, 502)

    @staticmethod
    def from_transport(exc: httpx.TransportError, *, is_write: bool) -> ApiError:
        if is_write:
            # Request may or may not have reached Clover: outcome unknown, must not be retried blindly.
            return ApiError(
                ErrorCode.UPSTREAM,
                "Lost connection to Clover during a write; the outcome is unknown. Re-read before retrying.",
                False,
                502,
            )
        return ApiError(ErrorCode.UPSTREAM, f"Could not reach Clover ({type(exc).__name__})", True, 502)

    @staticmethod
    def auth(message: str = "Missing or invalid X-App-Key") -> ApiError:
        return ApiError(ErrorCode.AUTH, message, False, 401)

    @staticmethod
    def validation(message: str) -> ApiError:
        return ApiError(ErrorCode.VALIDATION, message, False, 422)

    @staticmethod
    def not_found(message: str) -> ApiError:
        return ApiError(ErrorCode.NOT_FOUND, message, False, 404)

    @staticmethod
    def conflict(message: str) -> ApiError:
        return ApiError(ErrorCode.CONFLICT, message, False, 409)
