"""Hashing helpers for device keys and pairing codes. Raw secrets are never stored."""

from __future__ import annotations

import hashlib
import hmac
import secrets


class Secrets:
    PAIRING_CODE_DIGITS = 8

    @staticmethod
    def new_device_key() -> str:
        # 256 bits of entropy; a fast hash (SHA-256) is appropriate for high-entropy random keys.
        return secrets.token_urlsafe(32)

    @staticmethod
    def new_pairing_code() -> str:
        return "".join(secrets.choice("0123456789") for _ in range(Secrets.PAIRING_CODE_DIGITS))

    @staticmethod
    def hash(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def matches(value: str, expected_hash: str) -> bool:
        return hmac.compare_digest(Secrets.hash(value), expected_hash)

    @staticmethod
    def normalize_code(code: str) -> str:
        return "".join(ch for ch in code if ch.isdigit())
