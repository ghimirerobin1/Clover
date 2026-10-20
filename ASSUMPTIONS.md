# Assumptions (Milestones 1–2)

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
