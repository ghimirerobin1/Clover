# Stockroom — Clover inventory companion

Mobile inventory app (Expo / React Native) for a two-location grocery that uses **Clover POS as the
system of record**, plus a thin FastAPI proxy that holds the Clover credentials.

> **Status: Milestone 3 (Scan).** Skeleton + catalog (SQLite/FTS5, sync, Inventory, Item detail) + barcode scanning:
> full-screen camera with torch/zoom, barcode normalization (UPC-A/EAN-13/UPC-E/EAN-8, check digits, variable-weight),
> local → proxy lookup chain, Not-found actions, manual keypad. Stock writes arrive in Milestone 4.
> Nothing in this milestone writes stock to Clover. Scanning needs a dev build or Expo Go on a physical device.

## Architecture

```mermaid
flowchart LR
  subgraph Phone["Expo app (/app, /src)"]
    UI[Screens & components] --> API[src/api — only HTTP layer]
  end
  API -- "HTTPS + X-App-Key (per device)" --> Proxy
  subgraph Proxy["FastAPI proxy (/server)"]
    Routes --> Auth[Device keys - hashed, SQLite]
    Routes --> Client[CloverClient: rate limit, 429 retries for GETs, error mapping, idempotent writes]
  end
  Client -- "Bearer CLOVER_API_TOKEN" --> Clover[(Clover REST v3)]
  Client -. "CLOVER_MOCK=1" .-> Fixtures[(In-memory fixtures)]
```

The Clover token and merchant id live **only** in the proxy's environment. The app knows the proxy URL
and its own device key, nothing else.

## Prerequisites

- Node 20+ and npm
- Python 3.12 and [uv](https://docs.astral.sh/uv/) (or plain `pip`)
- Expo Go or a dev build on a device/simulator

## Run the proxy

```bash
cp .env.example server/.env        # CLOVER_MOCK=1 by default: no Clover account needed
cd server
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
curl localhost:8000/health         # {"status":"ok","mock":true,"version":"0.1.0"}
```

Without uv: `python3.12 -m venv .venv && . .venv/bin/activate && pip install fastapi "uvicorn[standard]" httpx pydantic pydantic-settings pytest pytest-asyncio respx`.

### Environment variables (server only)

| Var | Purpose |
|---|---|
| `CLOVER_MOCK` | `1` serves built-in fixtures; `0` calls real Clover |
| `CLOVER_API_TOKEN` | Merchant API token (required when not mocked) |
| `CLOVER_MERCHANT_ID` | Merchant id (required when not mocked) |
| `CLOVER_BASE_URL` | `https://sandbox.dev.clover.com` (sandbox) or `https://api.clover.com` (US prod) |
| `CLOVER_RATE_LIMIT_PER_SEC` / `_BURST` | Token bucket, default 8/s |
| `CLOVER_MAX_GET_ATTEMPTS` | Total tries for GETs on 429 (default 4). Writes are never retried |
| `DATABASE_PATH` | SQLite file for device keys, pairing codes, idempotency, audit |
| `PAIRING_CODE_TTL_SEC`, `PAIRING_MAX_FAILURES_PER_MIN` | Pairing hardening |

## Pair a device

```bash
cd server
uv run python -m app.pair                       # prints e.g. "Pairing code: 1483 4702" (10 min, single use)
uv run python -m app.pair --allow-create-items  # device may create Clover items (Milestone 6)
uv run python -m app.pair --list
uv run python -m app.pair --revoke <device-id>
```

The app redeems the code via `POST /pair {"code","deviceName"}` and gets an `appKey` once; only its
SHA-256 hash is stored. Every later request sends `X-App-Key`. `GET /me` checks a key.
In the app: **Settings → Pair this device**, enter the code and a device name. The key is kept in the OS
secure store and a full catalog sync starts.

## Run the app

```bash
npm install
EXPO_PUBLIC_PROXY_URL=http://<your-LAN-IP>:8000 npx expo start
```

`EXPO_PUBLIC_PROXY_URL` is the only app config and is not a secret. The Settings tab shows proxy
health (and whether it is in mock mode).

## Checks

```bash
npm run typecheck && npm run lint && npm test                       # app
cd server && uv run ruff check . && uv run mypy app tests && uv run pytest   # server
```

## Getting a Clover token

1. Create a Clover **sandbox developer account** at the Clover developer dashboard and a **test merchant**.
2. In the test merchant's dashboard, create an **API token** with **Inventory read + write** and **Merchant read**.
3. Put it in `server/.env` as `CLOVER_API_TOKEN`, set `CLOVER_MOCK=0`.
4. A single-merchant token must stay on the server. Production use across many merchants needs a
   **Clover OAuth app** instead (out of scope for v1).

**Merchant id:** shown in the merchant dashboard URL/account settings (13-char id) — set `CLOVER_MERCHANT_ID`.

**Track stock:** items must have stock tracking enabled in Clover Inventory ("Track stock" — VERIFY exact
setting name) or stock quantities will come back empty.

## Catalog API (proxy)

All require `X-App-Key`. `GET /locations/default/items?limit=1..1000&offset&modifiedSince=<ms>` →
`{items, offset, limit, hasMore}`; `GET /locations/default/items/{id}` (always fresh from Clover);
`GET /locations/default/categories`; `GET /locations/default/items/lookup?code=` → `{match, candidates}`
(code incl. UPC-A/EAN-13 variant, then SKU).

## Performance notes (10k+ items)

- List, search and filter screens read **only** from on-device SQLite; the network only refreshes SQLite.
  So scrolling and search don't depend on connectivity or Clover latency.
- First run: full sync paged at 1000, written in transactions of 500, with a progress count. Afterwards: delta sync by
  `modifiedSince` on launch, foreground, every 10 min, and pull-to-refresh. Header shows "Synced N min ago" and an amber
  banner when offline or > 1 h stale.
- Search uses an FTS5 prefix index on name/SKU/UPC (measured median 3 ms over 15k items in tests). Lists render with FlashList.
- Settings → Developer → **Seed 15,000 fake items** (dev builds only) for on-device testing.

## Future modules (seams)

- **Purchase orders / suppliers:** new `/src/features/purchasing` plus `/locations/{loc}/purchase-orders` routes;
  receiving reuses the stock write protocol.
- **Cost / margin reporting:** `cost_cents` is carried in the item model; a `/features/finance` module reads it.
- **CSV/PDF exports:** proxy endpoints over the audit log; app only triggers and shares.
- **Multi-location UI:** routes are already `/locations/{locationId}/...`; add entries to `Settings.location()`.
- **User accounts:** device keys already carry identity and a role flag; accounts would map onto them.
- **Clover OAuth:** replaces the static token in `LocationConfig`; the client is otherwise unchanged.
