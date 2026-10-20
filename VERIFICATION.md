# Verification guide (for the reviewer)

## Commands

```bash
# App (repo root) — Expo SDK 58 tooling expects Node >= 22.13 (tests/typecheck/lint also ran on Node 20.19)
npm install
npx tsc --noEmit
npx expo lint            # or: npx eslint .
npx jest

# Server
cd server
uv sync
uv run ruff check . && uv run ruff format --check .
uv run mypy app tests
uv run pytest -q

# Smoke test (mock mode)
CLOVER_MOCK=1 uv run uvicorn app.main:app --port 8000 &
curl localhost:8000/health
uv run python -m app.pair          # then: curl -XPOST localhost:8000/pair -H 'content-type: application/json' -d '{"code":"<code>","deviceName":"test"}'
curl localhost:8000/me -H "X-App-Key: <appKey>"

# Secrets grep (must return nothing)
rg -n -i "clover_api_token|merchant_id|CLOVER_MERCHANT" app src
```

## VERIFY items (confirm against current Clover docs)

| Location | What to confirm |
|---|---|
| `server/app/config.py:28` | Base URLs for non-US regions (EU / LatAm hosts) |
| `server/app/config.py:31` | Current per-token rate limit (we throttle at 8 req/s, burst 8) |
| `server/app/main.py:27` | Whether limits are per token or per merchant/app (one bucket per location token today) |
| `server/app/clover.py:79` | Auth header is `Authorization: Bearer <token>` for merchant API tokens |
| `server/app/clover.py:105` | Error bodies expose a `message` field |
| `server/app/mock.py:18` | Max `limit` for `GET /v3/merchants/{mId}/items` (assumed 1000) |
| `server/app/mock.py:23` | Item shape: `price`/`cost` cents, `itemStock.quantity`, `categories.elements`, `modifiedTime` (ms) |
| `server/app/mock.py:72` | `POST /v3/merchants/{mId}/item_stocks/{itemId}` with `{"quantity": N}` sets absolute stock |
| `server/app/mock.py:62` | Delta filter syntax `filter=modifiedTime>=<ms>` (mock implements this) |
| `server/app/catalog.py:16` | Max page size for `/items` (1000) |
| `server/app/catalog.py:18` | `expand=itemStock,categories` names |
| `server/app/catalog.py:57` | Item field names (`price`, `cost`, `modifiedTime`, `deleted`, `itemStock.quantity`, `categories.elements`) |
| `server/app/catalog.py:120` | Delta filter syntax; whether deleted items are returned by the delta query at all |
| `server/app/routes/catalog.py:42` | Category page size (assumes < 1000 categories) |
| `src/sync/CatalogSync.ts:33` | Client page size matches the proxy/Clover max (1000) |
| `README.md` | Exact name of the "Track stock" item setting |

## What the tests cover (Milestone 1)

- **Error mapping** (`tests/test_errors.py`): every status class → stable code/retryable/HTTP status; writes never retryable; transport errors.
- **Clover client** (`tests/test_clover_client.py`, respx): bearer header + merchant path; GET retries on 429 honoring Retry-After; stops at 4 tries; no retry on 500; writes never retried on 429; replay doesn't hit Clover twice; transport error mid-write → unknown state blocks blind retry; 4xx stored + replayed; id reuse with different body → CONFLICT; backoff math.
- **Idempotency store** (`tests/test_idempotency.py`).
- **Pairing** (`tests/test_pairing.py`): keys/codes stored only as hashes, single use, expiry, revoke, throttle, HTTP flow, CLI.
- **App/mock** (`tests/test_app.py`): `/health`, startup refuses missing creds, no secret leak, mock fixtures end-to-end incl. absolute stock write.
- **App** (jest): Button/Badge/Stepper/EmptyState/Skeleton/Sheet behavior and a11y roles, theme token ↔ CSS parity, proxy client error mapping.

## Milestone 2 (Catalog) coverage

- **Server routes** (`tests/test_catalog_routes.py`): auth required; pagination + `hasMore`; `modifiedSince` delta; untracked stock → `null`; fresh item read reflects upstream change (no cache); 404/unknown location; query validation → `VALIDATION`; real-mode request carries `expand`, `filter`, `limit`; malformed/float-price payloads fail loudly as `UPSTREAM`.
- **Money** (`src/lib/__tests__/money.test.ts`), **threshold resolution** (`thresholds.test.ts`), **FTS query builder** (`src/db/__tests__/fts.test.ts`).
- **SQLite repo** (`src/db/__tests__/items.test.ts`, WASM SQLite with FTS5 under Jest): migrations idempotent; prefix search on name/SKU/UPC; FTS triggers on update/delete; category/stock/not-counted filters with item → category → global thresholds; sorts; override survives sync.
- **Sync** (`src/sync/__tests__/CatalogSync.test.ts`): full sync paged at 1000 with progress; empty-final-page stop; delta cursor = max server `modifiedTime`; deletions; full re-sync prunes vanished items; failure mid-sync doesn't advance the cursor; single-flight; staleness text.
- **Search latency**: 15,000 seeded items, 21 queries — median **3.0 ms**, p95 **11 ms** on this box (WASM SQLite in Node, so only indicative of device performance). Test asserts median < 50 ms.

## Manual test script

Milestone 2 (Catalog):
1. Proxy in mock mode; in the app go to Settings → enter a code from `python -m app.pair` + device name → Pair. A full sync starts automatically.
2. Inventory shows 6 fixture items with stock badges (green / amber ≤ 5 / red ≤ 0 / grey "Not tracked"). Header says "Synced just now".
3. Search "jas", "rice-jas", "0731" → matching rows. Try filters (Low / Out / In stock, categories, Not counted 30d) and sort chips.
4. Tap an item → detail shows "Live from Clover"; stop the proxy, reopen → "Cached, may be stale" + warning.
5. Set a per-item threshold → badge colour updates in the list.
6. Stop proxy, pull to refresh → amber "Offline" banner; list still works.
7. Settings → Developer → "Seed 15,000 fake items" → shows seed + search time; scroll the list and search.
8. Settings → Clear local cache → list empty with "Sync now" action.

Milestone 1 scope:
1. Start the proxy in mock mode; `curl /health` shows `mock: true`.
2. `npx expo start`; app opens on **Scan** tab; all 5 tabs render an empty state.
3. Settings shows "Connected · mock mode"; stop the proxy, tap "Check again" → "Unreachable" with message.
4. Toggle device dark mode → colors switch (tabs + screens).
5. Pair via CLI + `/pair`; `/me` with key → 200, without → 401 `AUTH`.

Later milestones (not testable yet): scan found / not found / variable-weight, receive, count, adjust,
409 conflict, network drop mid-write, offline queue, undo, 15k-item seed performance.

## Known gaps / stubs

- No lookup, stock-write or create-item routes yet (Milestones 3–6).
- Per-item thresholds are stored **locally only**; the spec also wants them on the proxy — deferred (no proxy route yet).
- Category default thresholds have a column but no editor UI yet (Milestone 5 / Settings).
- `last_counted_at` is never set until Count lands (Milestone 4), so "Not counted 30d" currently matches everything.
- Stock history on item detail is a placeholder until the audit log (Milestone 4).
- Sync progress shows item count with an indeterminate bar (Clover gives no total count).
- Offline detection is inferred from the last sync failing with a network error (no NetInfo dependency).
- Not yet measured on a device: cold start, scroll fps, 10k full-sync time.
- Pairing throttle is in-process (resets on restart; per worker if run with multiple workers).
- `SUMMARY.md` (spec §9) is deferred to the final milestone; no performance numbers yet.
