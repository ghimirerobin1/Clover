# Assumptions (Milestone 1)

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
