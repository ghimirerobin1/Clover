"""Normalizes Clover item/category payloads into the stable shapes the app consumes.

Clover payloads vary, so parsing is defensive but strict about types: anything malformed raises
an UPSTREAM error instead of silently producing wrong stock or prices.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from .errors import ApiError, ErrorCode

# VERIFY: Clover's maximum page size for /items (assumed 1000).
MAX_PAGE_SIZE = 1000
# VERIFY: expand names `itemStock` and `categories` on GET /items.
ITEM_EXPAND = "itemStock,categories"


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ItemOut(CamelModel):
    id: str
    name: str
    sku: str | None
    code: str | None
    price_cents: int
    cost_cents: int | None
    category_id: str | None
    stock_qty: float | None  # None = stock not tracked in Clover
    modified_time: int  # epoch ms
    deleted: bool = False


class ItemPage(CamelModel):
    items: list[ItemOut]
    offset: int
    limit: int
    has_more: bool


class CategoryOut(CamelModel):
    id: str
    name: str
    sort_order: int | None


class CategoryList(CamelModel):
    categories: list[CategoryOut]


class _CloverItem(BaseModel):
    # VERIFY: field names id/name/sku/code/price/cost/modifiedTime/deleted/itemStock.quantity/categories.elements.
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str = ""
    sku: str | None = None
    code: str | None = None
    price: int = 0
    cost: int | None = None
    modifiedTime: int = 0  # noqa: N815 - Clover field name
    deleted: bool = False
    itemStock: dict[str, Any] | None = None  # noqa: N815
    categories: dict[str, Any] | None = None


class Catalog:
    @staticmethod
    def _upstream(what: str, exc: Exception) -> ApiError:
        return ApiError(ErrorCode.UPSTREAM, f"Unexpected {what} payload from Clover: {exc}"[:300], False, 502)

    @staticmethod
    def item(raw: Any) -> ItemOut:
        try:
            src = _CloverItem.model_validate(raw)
        except ValidationError as exc:
            raise Catalog._upstream("item", exc) from exc
        qty = (src.itemStock or {}).get("quantity")
        if qty is not None and not isinstance(qty, int | float):
            raise Catalog._upstream("item", ValueError("itemStock.quantity is not a number"))
        cats = (src.categories or {}).get("elements") or []
        category_id = cats[0].get("id") if cats and isinstance(cats[0], dict) else None
        return ItemOut(
            id=src.id,
            name=src.name,
            sku=src.sku or None,
            code=src.code or None,
            price_cents=src.price,
            cost_cents=src.cost,
            category_id=category_id,
            stock_qty=qty,
            modified_time=src.modifiedTime,
            deleted=src.deleted,
        )

    @staticmethod
    def elements(raw: Any, what: str) -> list[Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("elements", []), list):
            raise Catalog._upstream(what, ValueError("missing elements[]"))
        elements: list[Any] = raw.get("elements", [])
        return elements

    @staticmethod
    def category(raw: Any) -> CategoryOut:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise Catalog._upstream("category", ValueError("missing id"))
        order = raw.get("sortOrder")
        return CategoryOut(
            id=raw["id"], name=str(raw.get("name", "")), sort_order=order if isinstance(order, int) else None
        )

    @staticmethod
    def list_params(limit: int, offset: int, modified_since: int | None) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit, "offset": offset, "expand": ITEM_EXPAND}
        if modified_since is not None:
            # VERIFY: delta filter syntax; also whether deleted items are returned (they are skipped otherwise).
            params["filter"] = f"modifiedTime>={modified_since}"
        return params
