# Assumptions (Milestones 1–6)

Decisions not dictated by the spec. Each is the safest reasonable option.

## App
- **Expo SDK 58** (latest stable on npm at build time), React Native 0.88, React 19.3, TypeScript 6, Expo Router 58.
- No app icon/splash images are committed (repo rule: no media files). Expo falls back to defaults.
- Tab bar uses text labels only (no icon dependency yet). Icons can be added with `@expo/vector-icons` later.
- Theme tokens are RGB triplets in `src/theme/tokens.ts`, mirrored as CSS variables in `global.css` for
  NativeWind; a jest test fails if they drift. Dark mode follows the system (`prefers-color-scheme`);
  the manual theme switch (Settings) comes in a later milestone.
- `Sheet` is built on RN `Modal` (no `@gorhom/bottom-sheet`) to avoid extra native deps. It has an explicit
  "Close" button because the backdrop is hidden from screen readers.
- `EXPO_PUBLIC_PROXY_URL` (default `http://localhost:8000`) is the only app config; a URL is not a secret.
- `noUncheckedIndexedAccess` is on in addition to `strict`.
- `@testing-library/react-native` v14 is used with `test-renderer` (its required peer).

## Server
- `CLOVER_BASE_URL` defaults to the **sandbox** so a misconfigured server never hits production by accident.
- Server refuses to start without token + merchant id unless `CLOVER_MOCK=1`.
- Single location id `default`. Unknown location ids → `NOT_FOUND`.
- Pairing codes: 8 digits, single use, 10 min TTL, stored as SHA-256. Failed redemptions throttled
  in-process (10/min). Device keys: 256-bit random, stored as SHA-256 (fast hash is fine for high-entropy keys).
- Clover 401/403 → `AUTH` with HTTP **502** to the app (it is a server credential problem, not the device's);
  invalid/missing `X-App-Key` → `AUTH` with HTTP 401.
- Clover 400/422 → `VALIDATION`/422; 5xx and unknown statuses → `UPSTREAM`/502.
- `retryable` is always `false` for writes (spec: never auto-retry writes).
- GET retries happen **only on 429** (max 4 tries total). Delay = max(Retry-After, 0.5s·2ⁿ with 50–100% jitter), capped at 30 s.
  Other GET failures are returned immediately with `retryable` set so the app/TanStack Query decides.
- Idempotency is keyed by `(device_id, clientMutationId)` and a hash of method+path+body:
  - same id + different body → `CONFLICT`;
  - same id while still pending, or after a transport error / 5xx (outcome unknown) → `CONFLICT`
    telling the app to re-read and start a new change; the row is never auto-cleared;
  - Clover 429 on a write → row released (definitely not applied), so the same id can be re-confirmed;
  - definite 4xx → stored and replayed as the same error.
- Audit table schema is created now; rows are written from Milestone 4.
- Mock mode uses `httpx.MockTransport` over in-memory fixtures (`server/app/fixtures`), so the real
  client code path (auth header, rate limit, mapping, idempotency) is exercised.
- Python dependency management with `uv` (`pyproject.toml`); plain pip also works.

## Milestone 2 (Catalog)
- **Server item shape** (`ItemOut`): `id, name, sku, code, priceCents, costCents, categoryId, stockQty, modifiedTime, deleted`.
  `stockQty: null` means stock is not tracked in Clover. Only the first category is used as `categoryId`.
- Non-integer `price`/`cost` from Clover is rejected (`UPSTREAM`), never coerced, so float bugs surface.
- Delta cursor = **max `modifiedTime` seen** (Clover's clock), queried with `>=` (inclusive; re-upserts are harmless). The device clock is never used for the cursor.
- The cursor only advances after every page succeeds; a failed sync is simply re-run.
- Full sync removes local items not seen in that sync (`synced_at < this sync`). Delta sync relies on Clover returning `deleted: true`
  rows; if it doesn't (VERIFY), deletions are picked up on the next full re-sync (Settings → Full re-sync).
- Local overrides (`low_stock_threshold`, `last_counted_at`) are preserved across sync upserts.
- FTS5 external-content table over `items` kept in sync by triggers; tokenizer `unicode61 remove_diacritics 2`.
  User input is tokenized on non-alphanumerics and each token becomes a quoted prefix term (AND), so FTS operators can't be injected.
- "Low" filter = `0 < qty ≤ threshold`; "Out" = `qty ≤ 0`; untracked items appear only under "All".
- The inventory list loads all matching rows (only list columns) into memory and lets FlashList virtualize; fine at 15k rows.
- `SqlDb` interface wraps expo-sqlite (`ExpoSqlDb`) so the same SQL is tested under Jest with `node-sqlite3-wasm` (FTS5 enabled);
  `better-sqlite3` couldn't build here and `sql.js` lacks FTS5.
- `withTransactionAsync` (non-exclusive) is used because callbacks run on the same connection; sync is single-flight.
- The device key is stored in `expo-secure-store`. A minimal pairing form lives in Settings (needed to sync); full Settings polish is Milestone 6.
- Seeded fake items (`SEED_*`) are local only and are removed by the next full re-sync. The seed button renders only in `__DEV__`.
- Sync triggers: app launch, foreground, every 10 min while active, pull-to-refresh, Settings buttons. Successful sync bumps a
  `dataVersion` in a zustand store, which is part of every SQLite-backed TanStack Query key.
- `expo-asset` was added because `expo-sqlite` requires it at runtime.

## Milestone 3 (Scan)
- `Barcode.normalize` returns all equivalent forms as `candidates` (scanned form, UPC-A, EAN-13 with leading 0; for UPC-E also the expansion),
  because iOS reports UPC-A as EAN-13 and Clover may store either.
- Ambiguous 8-digit codes with no scanner type: EAN-8 if it validates as EAN-8; UPC-E if only the UPC-E expansion validates; if both validate,
  EAN-8 with the UPC-E forms added as extra candidates. 6/7-digit numeric input is treated as UPC-E.
- Invalid check digits do not block lookup (the code is still tried) but the Not-found sheet warns that the barcode may be misread.
- Variable-weight rule: UPC-A whose first digit(s) match a configured prefix (default `2`), followed by 5 item digits; the remaining 5 digits
  are "embedded" price/weight and are **not interpreted** (layouts differ by store/scale). Lookup uses the item portion, trying
  `201234`, `20123400000C` (zero-filled + valid check), `201234000000` and the EAN-13 form — covering the common ways stores key these into Clover.
- Prefix rule is read from the local `variable_weight_prefixes` setting (comma/space separated, e.g. `2, 02`); UI to edit it comes with Settings (M6).
- Lookup chain order is strict: local `code` → local `sku` (case-insensitive) → local `barcode_aliases` → proxy → not found. More than one hit at a stage = "Several items match" picker.
- Proxy lookup receives the most canonical form (item portion for weighted, else 12-digit UPC-A / GTIN); the server tries the 12↔13-digit variant itself, then SKU.
  A unique hit is `match`; several hits are `candidates`; deleted items are ignored. Proxy hits are upserted into SQLite so the next scan is local.
- Proxy failures (offline, auth) during lookup are shown on the Not-found sheet; local actions still work.
- "Link to existing item" stores the canonical code (`gtin`, else the cleaned code) as a local alias; relinking moves it.
- "Search manually" opens the Inventory tab pre-filled with the scanned code.
- Scanning is paused while any sheet is open; identical codes are ignored for 1.2 s (sliding while the code stays in view).
- Zoom uses −/+ buttons in 10 % steps (0–100 % of device max) instead of pinch. Torch is a toggle.
- The scanned-item sheet is read-only (cached stock badge, "View details", "Scan next"); stock actions arrive in Milestone 4.
- Camera permission string set via the `expo-camera` config plugin; microphone permission is not requested.

## Milestone 4 (Stock writes)
- One route `POST /locations/{loc}/stock/{id}` takes **absolute** `newQuantity` + `expectedQuantity`; the server re-reads live stock under a
  per-(location, item) lock and returns 409 `CONFLICT` with `currentQuantity` on mismatch. Clover is always sent an absolute quantity.
- Idempotency reuses the existing table: key = device + `clientMutationId`, hash covers path + body. Replays return the stored result
  (`replayed: true`) or the stored 409. A write whose outcome is unknown keeps its id **pending** (a re-send gets CONFLICT, which the app treats as unknown).
  429 releases the id. The app generates a new id per confirmation tap, so nothing is ever re-sent automatically.
- Audit log rows carry `status` (`applied` / `conflict` / `rejected` / `unknown`), `item_name` and `note` (additive column migration).
  `GET /locations/{loc}/audit` supports `itemId`, `action`, `since`, `before` (cursor) and `limit`.
- Undo = a new write of the inverse delta (`action: undo`) against a freshly fetched base, through the same confirmation card; 409 on undo recomputes from the new base.
- 409 recompute: Receive/Adjust/Undo keep the delta, Count keeps the absolute number (spec §4.4).
- "Destructive" styling when the result is lower than before or ≤ 0.
- Quantities are whole units in the app (Clover fractional stock is `VERIFY:`). Adjust needs a reason; nothing may go below zero.
- Unknown outcome: the app re-fetches live stock once (no write), caches it, and records a local `stock_changes` row with status `unconfirmed`
  shown at the top of Activity until the user re-checks or dismisses it.
- iOS cannot stack modals, so Scan closes its sheet and opens the stock sheet 350 ms later.
- `expo-crypto` added for `randomUUID` (mutation ids).

## Milestone 5 (Low Stock, continuous scan, batch apply, offline queue)
- **No new write path.** Batch rows and queued intents are written one at a time through `StockWriter.apply` (the M4 read-verify-write path,
  same server route, a fresh `clientMutationId` per row per confirmation tap). Only the stock sheet's Apply and the batch screen's Apply call it.
- Low Stock = tracked items with `stock_qty <= COALESCE(item, category, global)`, including zero/negative ("out") items; untracked items excluded.
  Grouped by category name (Uncategorized last), lowest stock first. The tab badge is the same count (hidden at 0, "99+" cap).
- Continuous mode: found items go straight to the tally (no sheet); not-found / several-matches still open their sheets (pausing the camera);
  picking a candidate adds it to the tally. The 1.2 s debounce is per identical code and slides while the code stays in view, so a held barcode
  counts once. Tally rows support −1 and Remove.
- The tally applies as **Count (set to tally)** by default — the mode is "counting" — with a toggle for **Receive (+tally)**.
- Batch: the screen reads live stock for every row first (reads only), shows before → after (destructive tint when lower/zero), allows removing rows,
  then writes sequentially. 409 rows show the new base and need another tap (Receive recomputes, Count keeps its number); failed rows stay for retry;
  an unknown outcome marks the row Unconfirmed (also in Activity) and **stops** the batch, and that row is never re-sent from the batch.
- Offline queue stores `(item, action, signed delta, reason, note)` only — the table has no expected/new quantity columns. Only Receive and Adjust can be
  queued; Count is refused (an absolute number captured against stale stock is exactly what the spec forbids). Queued rows show at the top of Activity
  with Discard and "Review & apply queued", which opens the batch confirmation against live stock. Nothing flushes automatically (no reconnect hook).
- Queue entries close as `applied` (confirmed), `sent` (unknown outcome; tracked as Unconfirmed) or `discarded`; conflicts/failures stay queued.
- Beep: a 70 ms 1760 Hz tone synthesized at runtime (no media file committed), cached to the app cache dir and played with expo-audio, mixing with
  other audio and respecting the silent switch. The expo-audio plugin is configured with no microphone permission.


## Milestone 6 (Create item, Settings, thresholds, performance)

- Create is gated twice: the local Settings toggle (default off, turned on only after a confirmation alert) **and** the device key's
  `canCreateItems` flag (`python -m app.pair --allow-create-items`). The app caches the flag from `/me`; the proxy re-checks it on every request.
- Create is a single attempt with a fresh `clientMutationId` per tap. Network / upstream / 409 → "outcome unknown"; the user checks by syncing
  or scanning. Nothing is retried automatically.
- The item is created with `priceType: FIXED`. Category link and initial stock are separate Clover calls; if one fails the item still exists,
  the response carries warnings and the audit row is `partial` (we don't retry or roll back).
- Initial stock 0 is sent as 0 (tracked); a blank field leaves stock untracked.
- Item and category thresholds are shared through the proxy (`thresholds` table) with a local outbox; pending local edits win over a pull,
  and between devices the last push wins. The global threshold stays per device.
- Theme override uses React Native `Appearance.setColorScheme` (`unspecified` = follow system).
- Version/build come from `app.json` (`version`, `ios.buildNumber`, `android.versionCode`) via `expo-constants`.
- Performance numbers are from the build box (WASM SQLite in Node; mock Clover in-process) and are a baseline, not device numbers.
