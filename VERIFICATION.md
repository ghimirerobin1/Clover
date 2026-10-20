# Verification guide (for the reviewer)

## Commands

```bash
# App (repo root)
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
| `README.md` | Exact name of the "Track stock" item setting |

Not yet used (land in Milestone 2): `expand=itemStock,categories` names, `modifiedTime` filter syntax.

## What the tests cover (Milestone 1)

- **Error mapping** (`tests/test_errors.py`): every status class → stable code/retryable/HTTP status; writes never retryable; transport errors.
- **Clover client** (`tests/test_clover_client.py`, respx): bearer header + merchant path; GET retries on 429 honoring Retry-After; stops at 4 tries; no retry on 500; writes never retried on 429; replay doesn't hit Clover twice; transport error mid-write → unknown state blocks blind retry; 4xx stored + replayed; id reuse with different body → CONFLICT; backoff math.
- **Idempotency store** (`tests/test_idempotency.py`).
- **Pairing** (`tests/test_pairing.py`): keys/codes stored only as hashes, single use, expiry, revoke, throttle, HTTP flow, CLI.
- **App/mock** (`tests/test_app.py`): `/health`, startup refuses missing creds, no secret leak, mock fixtures end-to-end incl. absolute stock write.
- **App** (jest): Button/Badge/Stepper/EmptyState/Skeleton/Sheet behavior and a11y roles, theme token ↔ CSS parity, proxy client error mapping.

## Manual test script

Milestone 1 scope:
1. Start the proxy in mock mode; `curl /health` shows `mock: true`.
2. `npx expo start`; app opens on **Scan** tab; all 5 tabs render an empty state.
3. Settings shows "Connected · mock mode"; stop the proxy, tap "Check again" → "Unreachable" with message.
4. Toggle device dark mode → colors switch (tabs + screens).
5. Pair via CLI + `/pair`; `/me` with key → 200, without → 401 `AUTH`.

Later milestones (not testable yet): scan found / not found / variable-weight, receive, count, adjust,
409 conflict, network drop mid-write, offline queue, undo, 15k-item seed performance.

## Known gaps / stubs

- No item, lookup, stock, categories or create-item routes yet (Milestones 2–6); `CloverClient.write` and the idempotency table are ready for them.
- No in-app pairing UI or secure-store key handling yet.
- No SQLite/sync, TanStack Query, Zustand, FlashList, camera — not installed until their milestone.
- Pairing throttle is in-process (resets on restart; per worker if run with multiple workers).
- `SUMMARY.md` (spec §9) is deferred to the final milestone; no performance numbers yet.
