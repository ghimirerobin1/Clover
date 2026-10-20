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
rg -n -i "clover_api_token|merchant_id|CLOVER_MERCHANT|MOCKMERCHANT|mock-token" app src

# Performance (spec §6)
PERF=1 PERF_OUT=/tmp/perf.json npx jest src/perf   # app-side, WASM SQLite under Node
cd server && PYTHONPATH=. uv run python scripts/perf_proxy.py
```

## VERIFY items (confirm against current Clover docs)

| Location | What to confirm |
|---|---|
| `server/app/config.py:28` | Base URLs for non-US regions (EU / LatAm hosts) |
| `server/app/config.py:31` | Current per-token rate limit (we throttle at 8 req/s, burst 8) |
| `server/app/main.py:29` | Whether limits are per token or per merchant/app (one bucket per location token today) |
| `server/app/clover.py:95` | Auth header is `Authorization: Bearer <token>` for merchant API tokens |
| `server/app/clover.py:121` | Error bodies expose a `message` field |
| `server/app/mock.py:18` | Max `limit` for `GET /v3/merchants/{mId}/items` (assumed 1000) |
| `server/app/mock.py:23` | Item shape: `price`/`cost` cents, `itemStock.quantity`, `categories.elements`, `modifiedTime` (ms) |
| `server/app/mock.py:67` | Delta filter syntax `filter=modifiedTime>=<ms>` (mock implements this) |
| `server/app/mock.py:78` | Create response is the new item (id, modifiedTime) without `itemStock` until stock is set |
| `server/app/mock.py:114` | `POST item_stocks/{itemId}` with `{"quantity": N}` sets absolute stock |
| `server/app/catalog.py:16` | Max page size for `/items` (1000) |
| `server/app/catalog.py:18` | `expand=itemStock,categories` names |
| `server/app/catalog.py:57` | Item field names (`price`, `cost`, `modifiedTime`, `deleted`, `itemStock.quantity`, `categories.elements`) |
| `server/app/catalog.py:120` | Delta filter syntax; whether deleted items are returned by the delta query at all |
| `server/app/catalog.py:147` | Lookup filter `filter=code=<v>` / `filter=sku=<v>`; whether alternate barcodes are queryable (not used — local `barcode_aliases`) |
| `server/app/routes/catalog.py:64` | Category page size (assumes < 1000 categories) |
| `server/app/stock.py:155` | Whether Clover accepts fractional stock (app allows whole units only; sent as ints) |
| `server/app/stock.py:208` | `POST item_stocks/{itemId}` `{"quantity": N}` sets **absolute** stock (we never send deltas) |
| `server/app/stock.py` (live read) | `GET /items/{id}?expand=itemStock` reflects sales immediately (expected-quantity check relies on it) |
| `server/app/create_item.py:66` | `POST /v3/merchants/{mId}/items` accepts `{name, price (cents), priceType: FIXED, sku, code}` |
| `server/app/create_item.py:127` | Category link via `POST /v3/merchants/{mId}/category_items` `{"elements":[{item, category}]}` |
| `server/app/create_item.py:140` | Initial stock via `POST item_stocks/{id}` on a brand-new item (stock tracking may need enabling first) |
| `src/sync/CatalogSync.ts:33` | Client page size matches the proxy/Clover max (1000) |
| `src/lib/barcode.ts` (spec, not Clover) | Store's variable-weight layout (prefix `2`, 5 item digits; now editable in Settings → Scanning) |
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

## Milestone 3 (Scan) coverage

- **Barcode normalization** (`src/lib/__tests__/barcode.test.ts`, 42 tests): whitespace/invisible-char cleanup; GTIN check digits (UPC-A, EAN-13, EAN-8, GTIN-14) valid + invalid; UPC-E → UPC-A for every last-digit rule (0–2, 3, 4, 5–9), 6/7/8-digit forms, bad number systems; UPC-A ↔ EAN-13 (leading 0) candidates; ambiguous 8-digit EAN-8 vs UPC-E; GTIN-14 wrapper; non-GTIN pass-through; variable-weight detection, item-portion lookup that ignores the embedded price, EAN-13 form, configurable prefix rule, `parseRule`.
- **Lookup chain** (`src/features/scan/__tests__/LookupChain.test.ts`, WASM SQLite): local code (incl. EAN-13 and UPC-E forms) → sku (case-insensitive) → aliases → proxy (canonical code sent, hit cached into SQLite) → not found; duplicates → ambiguous; proxy/network errors reported, not thrown; empty input skips network; alias relinking; 1.2 s scan debounce.
- **Scan sheets** (`ScanSheets.test.tsx`): Not-found sheet actions, Create hidden unless enabled, invalid-check-digit and offline warnings, link picker, weighted-item note, keypad.
- **Server lookup** (`server/tests/test_lookup_route.py`): auth; match by UPC, by EAN-13 form of stored UPC-A, by SKU; not found; duplicates → `candidates`; `/items/lookup` not shadowed by `/items/{id}`; validation; real-mode query order `code` → `code` variant → `sku`.

## Milestone 4 (Stock writes) coverage

- `server/tests/test_stock_routes.py` (15): auth; applied write + audit row; 409 with `currentQuantity` and a `conflict` audit row, no upstream write;
  idempotent replay (same `clientMutationId` → same result, `replayed: true`, **one** upstream call); replayed 409; id reuse with a different body;
  ids scoped per device; validation (reason required for adjust, ranges); untracked/missing item; audit filters + pagination;
  transport failure / 5xx → unknown, audit `unknown`, no retry, id stays pending; 429 frees the id; absolute body `{"quantity": 9}`; audit column migration.
- `src/features/stock/__tests__/StockMath.test.ts`: target, **409 rebase rules** (Receive/Adjust/Undo recompute from new base, Count keeps absolute),
  destructive styling rule, validation, undo inverse.
- `src/features/stock/__tests__/StockWriter.test.ts` (WasmSqlDb + fake proxy): applied → optimistic SQLite + `last_counted_at` on Count;
  conflict → live cached, nothing written, re-confirm with a new mutation id; **unknown outcome** (NETWORK / UPSTREAM / pending CONFLICT / non-ApiError)
  → Unconfirmed row + re-fetched live, exactly one write call; failures classified; invalid intents never hit the network; undo incl. 409 on undo.
- `src/features/stock/__tests__/StockSheet.test.tsx`: sheet fetches fresh stock on open; **no write before the Apply tap**; offline disables Apply;
  409 shows live value and needs a second tap; unknown shows Unconfirmed with Apply disabled; ConfirmCard destructive styling;
  a source scan asserting only `StockWriter` calls `writeStock` and only `StockSheet` calls `StockWriter.apply`.

## Milestone 5 (Low Stock, continuous scan, batch, offline queue) coverage

- `src/features/lowstock/__tests__/LowStock.test.ts`: `stock_qty <= threshold` with item → category → global resolution (item override 0 beats
  global; negative and zero stock included; untracked never low), global-default changes, category grouping (Uncategorized last, lowest first), tab badge.
- `src/features/batch/__tests__/Tally.test.ts`: increment on repeat, decrement/remove, immutability; debounce + tally (held barcode counts once,
  re-presented after 1.2 s counts again); synthesized beep WAV header.
- `src/features/scan/__tests__/LookupChain.test.ts`: debounce is now **per identical code** (two codes alternating in frame can't double-count).
- `src/features/batch/__tests__/BatchRunner.test.ts`: live reads before writes; **mixed batch** (applied / 409 / 422 / applied) written strictly
  sequentially (max 1 in flight, no reads or retries in the run); second tap re-sends only conflict+failed rows, Receive recomputes from the new base,
  Count keeps its absolute number; unknown outcome → Unconfirmed, batch stops, row never re-sent; invalid/offline rows skipped without requests;
  fresh mutation id per write; queued intents close only when applied/sent, conflicts stay queued and the delta applies to the *live* base.
- `src/features/batch/__tests__/IntentQueue.test.ts`: the table has **no absolute-quantity column**; Count is refused by the repo and by a SQL CHECK;
  validation; one-way close; a source scan proving the queue is read only by Activity and the batch screen, `BatchRunner.run` is called only from the
  batch screen's Apply, and nothing under `src/sync` touches the queue (**never auto-flush**).
- `src/features/batch/__tests__/BatchScreen.test.tsx`: lists every row live before → after; no write before the Apply tap; per-row ✓/Conflict;
  applied rows leave the tally; Receive mode; row removal; offline rows can't be applied.
- `src/features/stock/__tests__/StockSheet.test.tsx`: offline sheet queues Receive as a delta with no write; Count can't be queued; the write-path
  scan now allows exactly `StockSheet.tsx` and `BatchRunner.ts` to call `StockWriter.apply` (still the only caller of `writeStock`).

## Milestone 6 (Create item, Settings, thresholds, performance) coverage

- `src/features/create/__tests__/CreateItem.test.ts`: gate matrix (setting × device flag, default off), validation (name, cents mask, stock, lengths), request mapping, summary, writer outcomes (success upserts; 403 clears the cached flag; network/upstream/409 → unknown, single attempt), and a static check that only `CreateItem.ts` calls `.createItem(`.
- `CreateItemScreen.test.tsx`: gate-off empty state; form → Review summary → Create; unknown panel.
- `src/sync/__tests__/ThresholdSync.test.ts`: outbox push order, stop on failure, pending edits win over pull, clear.
- `src/features/settings/__tests__/AppPrefs.test.ts`: theme, threshold and prefix parsing, version.
- `server/tests/test_create_and_thresholds.py` (10): key required; gated off → 403, nothing created, no audit; applied + audited; replay idempotent; reuse id + other body → 409; validation; unknown → pending → 409, one Clover call; 429 frees id; 400 stored and replayed; follow-up failure → warning + `partial`; thresholds round-trip and clear.

### Performance (measured on the build box, not a device)

App (`src/perf`, WASM SQLite in Node — a rough baseline only; integer-ms timer):
| Metric (15k items) | Result |
|---|---|
| Seed 15,000 items | 842 ms |
| FTS search, 70 queries | p50 4 ms · p95 6 ms · max 10 ms |
| List: all by name / stock asc / low filter / not counted 30d | 211 / 206 / 21 / 213 ms |
| Low Stock query (3,135 rows) / count / group | 45 / 3 / 9 ms |
| Scan lookup from cache | p50 0 ms · p95 1 ms |
| Client full sync of 10k (parse + write) | 492 ms |

Proxy (`scripts/perf_proxy.py`, mock Clover in-process, includes the 8 req/s limiter, excludes real Clover latency):
| Metric | Result |
|---|---|
| Full catalog 10k via proxy (pages of 1000) | 389 ms |
| Fresh item read (limiter-bound) | p50 125 ms · p95 127 ms |
| Stock write (read + write, 2 Clover calls) | p50 250 ms · p95 253 ms |

Android JS bundle (`expo export`): 5.04 MB Hermes bytecode.

**Needs a device:** cold start (< 2 s), scroll at 60 fps on 15k, scan → sheet (< 300 ms), real Wi-Fi full sync against Clover, beep/haptics feel, `Appearance.setColorScheme` theme override.

### End-to-end (mock mode, real HTTP)

```
cd server
CLOVER_MOCK=1 DATABASE_PATH=/tmp/e2e.sqlite3 uv run uvicorn app.main:app --port 8765 &
CLOVER_MOCK=1 DATABASE_PATH=/tmp/e2e.sqlite3 uv run python scripts/e2e_mock.py --base http://127.0.0.1:8765
```

`scripts/e2e_mock.py` pairs two devices via the CLI + `/pair`, then drives receive, count, adjust (and adjust without reason → 422),
a forced 409 (device B changes stock between A's read and write) with re-confirm, an idempotent retry (replayed, same audit id, applied once;
same id + different body → 409), and a 4-row batch (200 / 200 / 422 untracked / 409 after a sale) with the conflict re-confirmed,
then checks the audit feed. M6 adds create-item (gated-off device → 403 and nothing created; manager key → created with price/stock/category; replay → same id, one item; same id + different body → 409; float price → 422; audited once; receive on the new item) and shared thresholds. Last run (Oct 20 2026, 2:30 PM CDT): **40/40 checks passed**, audit `{applied: 10, conflict: 3}`.

## Manual test script

Milestone 3 (Scan) — needs a physical device (camera):
1. Scan tab asks for camera permission; deny → "Camera access needed" with manual entry.
2. Allow → full-screen camera with viewfinder; toggle torch; zoom −/+/reset.
3. Scan a fixture-coded item (or print UPC `074410000123`) → haptic → item sheet with name, price, cached stock, "View details".
4. Scan a code not in the catalog → proxy lookup → Not found sheet: Search manually (opens Inventory pre-searched), Link to existing item (pick one; rescan → found via alias). "Create in Clover" is not shown unless enabled (M6, step 15).
5. Variable-weight: enter `201234012999`-style code (prefix 2) on the keypad → Pork Belly + "Weighted item — stock tracked by unit".
6. Holding the same barcode in view does not reopen the sheet repeatedly (1.2 s debounce; scanning paused while a sheet is open).
7. Enter code manually → keypad → Look up. No stock writes anywhere.

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

Milestone 4 (mock mode):
6. Item detail → Receive → +24 → card shows "Current 14 → New 38" → Apply → haptic, toast with Undo; Activity tab shows the row.
7. Tap Undo within 10 s → a new confirmation "38 → 14" (red) → Apply.
8. Open Count, then change stock out of band (`curl` the mock/another device), Apply → "Stock changed to X… Set to N?" → Re-confirm.
9. Open a sheet, stop the proxy → Apply disabled ("Cached, may be stale"). Kill the proxy *during* Apply → "Unconfirmed"; Activity lists it with Re-check / Dismiss; nothing retries.
10. Adjust −N below zero → blocked; Adjust without a reason → blocked.

Milestone 5:
11. Low Stock tab: badge shows the count; set an item threshold on item detail → it moves in/out; tap Receive on a row → stock sheet.
12. Scan → Counting: scan the same item 3× (lift away between reads) → "Jasmine Rice 20lb ×3" with beep + haptic; holding it in view counts once.
13. Review & apply → every row shows live before → after; remove a row; Count vs Receive toggle; Apply → per-row ✓ / Conflict / Failed; tap again to retry.
14. Stop the proxy, open Receive → "Queue for later (+24)"; Activity shows it as Queued. Restart proxy: nothing is sent until "Review & apply queued".

Milestone 6:
15. Create item: pair a normal device → Settings → "Allow creating items" is disabled ("not allowed for this device key"). Pair with `python -m app.pair --allow-create-items` → toggle → confirmation alert → on. Scan an unknown code → Not found → Create in Clover → UPC prefilled; type `349` → "$3.49"; Review → summary → Create in Clover → item opens; Inventory shows it. Kill the proxy during Create → "Outcome unknown" panel, no retry.
16. Settings: global threshold (0–9999) changes Low Stock; category editor sets a category default; a second device sees item/category thresholds after sync. Scan defaults (mode, beep, haptics), variable-weight prefixes (e.g. `2,02`), theme System/Light/Dark, Clear cache → list empty, sync restores items and thresholds. About shows version/build.
17. Performance on device: Settings → Developer → Seed 15,000 → cold start, scroll fps, search, scan → sheet time; record the numbers here.

## Known gaps / stubs

- Beep (synthesized WAV via expo-audio + expo-file-system) and continuous-scan ergonomics are not yet verified on a device.
- Tally is in memory (zustand): it survives navigation but not an app restart.
- Batch rows whose outcome was unknown are not re-sent; resolve them in Activity (Unconfirmed).
- Barcode aliases are local only (per spec); they are not synced between devices.
- Scan → sheet latency (< 300 ms target) not yet measured on a device.
- `last_counted_at` is set by local Counts only (not by counts from other devices until a sync rule exists).
- Stock history / Activity show only writes made through this proxy (Clover sales are not in the audit log).
- Unconfirmed rows are resolved manually (Re-check / Dismiss); there is no automatic reconciliation against the audit log yet.
- Undo toast lives 10 s in memory only; it does not survive an app restart.
- Per-item write lock is in-process (one proxy worker assumed).
- Sync progress shows item count with an indeterminate bar (Clover gives no total count).
- Offline detection is inferred from the last sync failing with a network error (no NetInfo dependency).
- Pairing throttle is in-process (resets on restart; per worker if run with multiple workers).
- Global low-stock threshold is per device (only item/category thresholds are shared via the proxy).
- Threshold conflicts between devices: last push wins (no per-field merge).
- Create item follow-ups (category link, initial stock) are best-effort; failures return warnings and the audit row is `partial`.
- Not yet measured on a device: cold start, scroll fps, scan → sheet latency, real Clover sync (see Performance).
