"""CLOVER_MOCK=1: an in-memory fake of the Clover endpoints we use, served through httpx.MockTransport,
so the proxy (and the app) work end-to-end with no Clover account.

Shapes mirror our best understanding of Clover v3 and are marked VERIFY where unsure.
"""

from __future__ import annotations

import copy
import json
import re
from importlib import resources
from typing import Any

import httpx

MOCK_BASE_URL = "https://clover.mock"
# VERIFY: Clover's max page size for /items (assumed 1000).
MAX_LIMIT = 1000


class MockClover:
    # VERIFY: item shape (price/cost in cents, itemStock.quantity, categories.elements, modifiedTime ms).
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {i["id"]: i for i in MockClover._fixture("items.json")["elements"]}
        self.categories: list[dict[str, Any]] = MockClover._fixture("categories.json")["elements"]

    @staticmethod
    def _fixture(name: str) -> dict[str, Any]:
        text = resources.files("app.fixtures").joinpath(name).read_text(encoding="utf-8")
        data: dict[str, Any] = json.loads(text)
        return data

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, body: Any) -> httpx.Response:
        return httpx.Response(status, json=body)

    def handle(self, request: httpx.Request) -> httpx.Response:
        m = re.fullmatch(r"/v3/merchants/[^/]+/(.+)", request.url.path)
        if not m:
            return self._json(404, {"message": "Not found"})
        rest = m.group(1)
        if request.method == "GET" and rest == "items":
            return self._list_items(request)
        if request.method == "GET" and rest == "categories":
            return self._json(200, {"elements": copy.deepcopy(self.categories)})
        if (im := re.fullmatch(r"items/([^/]+)", rest)) and request.method == "GET":
            item = self.items.get(im.group(1))
            return self._json(200, copy.deepcopy(item)) if item else self._json(404, {"message": "Item not found"})
        if sm := re.fullmatch(r"item_stocks/([^/]+)", rest):
            return self._item_stock(request, sm.group(1))
        return self._json(404, {"message": "Not found"})

    def _list_items(self, request: httpx.Request) -> httpx.Response:
        params = request.url.params
        limit = min(int(params.get("limit", "100")), MAX_LIMIT)
        offset = int(params.get("offset", "0"))
        rows = sorted(self.items.values(), key=lambda i: i["id"])
        # VERIFY: Clover filter syntax `filter=modifiedTime>=<ms>` for delta sync.
        for f in params.get_list("filter"):
            if m := re.fullmatch(r"modifiedTime>=(\d+)", f):
                since = int(m.group(1))
                rows = [r for r in rows if int(r.get("modifiedTime", 0)) >= since]
        return self._json(200, {"elements": copy.deepcopy(rows[offset : offset + limit])})

    def _item_stock(self, request: httpx.Request, item_id: str) -> httpx.Response:
        item = self.items.get(item_id)
        if item is None:
            return self._json(404, {"message": "Item not found"})
        if request.method == "GET":
            qty = item.get("itemStock", {}).get("quantity")
            return self._json(200, {"item": {"id": item_id}, "quantity": qty})
        if request.method == "POST":
            # VERIFY: Clover item_stocks POST sets absolute quantity ({"quantity": N}).
            body = json.loads(request.content or b"{}")
            qty = body.get("quantity")
            if not isinstance(qty, int | float):
                return self._json(400, {"message": "quantity is required"})
            item["itemStock"] = {"quantity": qty}
            return self._json(200, {"item": {"id": item_id}, "quantity": qty})
        return self._json(405, {"message": "Method not allowed"})
