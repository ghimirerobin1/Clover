from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..auth import CurrentDevice
from ..catalog import ITEM_EXPAND, MAX_PAGE_SIZE, Catalog, CategoryList, ItemOut, ItemPage, Lookup, LookupResult
from ..clover import CloverClient, CloverRegistry
from ..errors import ErrorMapper

router = APIRouter(prefix="/locations/{location_id}")


def _clover(request: Request, location_id: str) -> CloverClient:
    registry: CloverRegistry = request.app.state.clover
    return registry.get(location_id)


@router.get("/items", response_model=ItemPage, response_model_by_alias=True)
async def list_items(
    location_id: str,
    request: Request,
    _device: CurrentDevice,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    modified_since: Annotated[int | None, Query(alias="modifiedSince", ge=0)] = None,
) -> ItemPage:
    raw = await _clover(request, location_id).get("/items", Catalog.list_params(limit, offset, modified_since))
    items = [Catalog.item(e) for e in Catalog.elements(raw, "items")]
    return ItemPage(items=items, offset=offset, limit=limit, has_more=len(items) == limit)


@router.get("/items/lookup", response_model=LookupResult, response_model_by_alias=True)
async def lookup_item(
    location_id: str,
    request: Request,
    _device: CurrentDevice,
    code: Annotated[str, Query(min_length=1, max_length=Lookup.MAX_CODE_LEN)],
) -> LookupResult:
    """Match by code (UPC, incl. UPC-A/EAN-13 variants), then SKU. Unique hit -> match; several -> candidates."""
    value = "".join(code.split())
    if not value:
        raise ErrorMapper.validation("code is required")
    clover = _clover(request, location_id)
    found: list[ItemOut] = []
    for flt in Lookup.filters(value):
        raw = await clover.get("/items", {"filter": flt, "expand": ITEM_EXPAND, "limit": 10})
        found = [Catalog.item(e) for e in Catalog.elements(raw, "items")]
        if found:
            break
    return Lookup.result(found)


@router.get("/items/{item_id}", response_model=ItemOut, response_model_by_alias=True)
async def get_item(location_id: str, item_id: str, request: Request, _device: CurrentDevice) -> ItemOut:
    """Always hits Clover (never cached) — used for fresh stock before any write."""
    raw = await _clover(request, location_id).get(f"/items/{item_id}", {"expand": ITEM_EXPAND})
    return Catalog.item(raw)


@router.get("/categories", response_model=CategoryList, response_model_by_alias=True)
async def list_categories(location_id: str, request: Request, _device: CurrentDevice) -> CategoryList:
    # VERIFY: categories page size; assumes < MAX_PAGE_SIZE categories per merchant.
    raw = await _clover(request, location_id).get("/categories", {"limit": MAX_PAGE_SIZE})
    return CategoryList(categories=[Catalog.category(e) for e in Catalog.elements(raw, "categories")])
