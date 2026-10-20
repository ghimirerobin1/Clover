"""Server configuration. All Clover credentials live here (env), never in the mobile app."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_LOCATION_ID = "default"


@dataclass(frozen=True)
class LocationConfig:
    """One store location == one Clover merchant + token (spec §3). Merchant id never comes from clients."""

    location_id: str
    merchant_id: str
    api_token: str


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    clover_api_token: str = ""
    clover_merchant_id: str = ""
    # VERIFY: region base URLs if non-US (EU/LatAm use different hosts).
    clover_base_url: str = "https://sandbox.dev.clover.com"
    clover_mock: bool = False
    # VERIFY: Clover's current per-token rate limit; spec default is ~8 req/s, kept below the limit.
    clover_rate_limit_per_sec: float = Field(default=8.0, gt=0)
    clover_rate_limit_burst: int = Field(default=8, ge=1)
    clover_max_get_attempts: int = Field(default=4, ge=1)
    clover_timeout_sec: float = Field(default=15.0, gt=0)

    database_path: str = "stockroom.sqlite3"
    pairing_code_ttl_sec: int = Field(default=600, ge=60)
    # Failed pairing attempts allowed per minute (in-process throttle against code guessing).
    pairing_max_failures_per_min: int = Field(default=10, ge=1)

    def location(self, location_id: str) -> LocationConfig | None:
        """Single default location for now; multi-location becomes a config change here."""
        if location_id != DEFAULT_LOCATION_ID:
            return None
        if self.clover_mock:
            return LocationConfig(location_id, "MOCKMERCHANT", "mock-token")
        return LocationConfig(location_id, self.clover_merchant_id, self.clover_api_token)

    def validate_for_startup(self) -> None:
        if not self.clover_mock and not (self.clover_api_token and self.clover_merchant_id):
            raise RuntimeError(
                "CLOVER_API_TOKEN and CLOVER_MERCHANT_ID are required unless CLOVER_MOCK=1. See .env.example."
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
