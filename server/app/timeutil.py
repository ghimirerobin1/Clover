from __future__ import annotations

from datetime import UTC, datetime


class Clock:
    @staticmethod
    def now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def iso(dt: datetime | None = None) -> str:
        return (dt or Clock.now()).isoformat()
