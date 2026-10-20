"""Per-item and per-category low-stock thresholds shared across devices (spec §4.5).

Stored on the proxy only; never written to Clover.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .catalog import CamelModel
from .db import Database
from .timeutil import Clock


class ThresholdScope(StrEnum):
    ITEM = "item"
    CATEGORY = "category"


class ThresholdIn(CamelModel):
    threshold: int | None = Field(default=None, ge=0, le=1_000_000)


class ThresholdMap(CamelModel):
    items: dict[str, int]
    categories: dict[str, int]


class Thresholds:
    @staticmethod
    def set(
        db: Database, location_id: str, scope: ThresholdScope, ref_id: str, value: int | None, device_id: str
    ) -> None:
        with db.connect() as conn:
            if value is None:
                conn.execute(
                    "DELETE FROM thresholds WHERE location_id = ? AND scope = ? AND ref_id = ?",
                    (location_id, scope.value, ref_id),
                )
                return
            conn.execute(
                "INSERT INTO thresholds (location_id, scope, ref_id, threshold, device_id, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(location_id, scope, ref_id) DO UPDATE SET threshold = excluded.threshold, "
                "device_id = excluded.device_id, updated_at = excluded.updated_at",
                (location_id, scope.value, ref_id, value, device_id, Clock.iso()),
            )

    @staticmethod
    def all(db: Database, location_id: str) -> ThresholdMap:
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT scope, ref_id, threshold FROM thresholds WHERE location_id = ?", (location_id,)
            ).fetchall()
        out = ThresholdMap(items={}, categories={})
        for r in rows:
            (out.items if r["scope"] == ThresholdScope.ITEM.value else out.categories)[r["ref_id"]] = int(
                r["threshold"]
            )
        return out
