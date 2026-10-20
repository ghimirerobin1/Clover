# Stockroom — summary (v1, Milestones 1–6)

## What works (tested; mock mode end-to-end)
- **Proxy** (FastAPI): device pairing (codes, keys, revoke, `canCreateItems` flag), catalog paging/delta/lookup, read-verify-write stock writes
  (expected-quantity check → 409, idempotency keys, per-item lock, audit log), batch apply, gated create item, shared thresholds,
  8 req/s token bucket, one write attempt only (unknown outcomes stay pending, never retried). Mock Clover for everything.
- **App** (Expo): offline-first SQLite catalog with FTS5 search, filters and sort; scan (camera, torch, zoom, manual entry,
  variable-weight codes, local barcode aliases); Receive / Count / Adjust with a before → after confirmation on every write; Undo;
  Activity (incl. unconfirmed and queued); Low Stock tab; continuous counting scan + Review & apply; offline intent queue (never auto-flushed);
  gated Create item (cents mask, UPC prefilled, summary before write); full Settings (thresholds, category editor, scan defaults,
  variable-weight prefixes, theme, create toggle, clear cache, version/build).
- **Checks:** jest 282/282 (24 suites), tsc strict, eslint; pytest 115, ruff, mypy --strict; e2e mock script 40/40.

## Partial / not verified
- Everything tagged `VERIFY:` (Clover request/response shapes, especially create, category link, initial stock) — see VERIFICATION.md.
- Not run on a physical device in this environment: camera scanning, beep/haptics, theme override, cold start, scroll fps.
- Create follow-ups (category, initial stock) are best-effort: failures are reported as warnings, not retried.
- Global threshold is per device; threshold conflicts are last-push-wins.
- Tally, Undo and unconfirmed resolution are in memory or manual; per-item lock and pairing throttle are single-process.

## Measured numbers (build box, not a device)
| Metric | Result |
|---|---|
| Seed 15k items | 842 ms |
| Search on 15k (FTS5) | p50 4 ms · p95 6 ms · max 10 ms |
| List queries on 15k (all / stock asc / low / not counted) | 211 / 206 / 21 / 213 ms |
| Low Stock query / count / group | 45 / 3 / 9 ms |
| Scan lookup from cache | p50 0 ms · p95 1 ms |
| Client full sync 10k (parse + SQLite) | 492 ms |
| Proxy full catalog 10k (mock Clover, incl. limiter) | 389 ms |
| Proxy fresh read / stock write (limiter-bound) | p50 125 ms / 250 ms |
| Android Hermes bundle | 5.04 MB |

Spec targets that need a device: cold start < 2 s, 60 fps scrolling at 15k, scan → sheet < 300 ms, real Clover full sync.

## Top 5 next steps
1. Run against a real Clover sandbox and resolve every `VERIFY:` item (create item, category link, item_stocks, filters, page sizes).
2. On-device pass (mid-range Android + iPhone): the manual test script plus the device-only perf numbers, recorded in VERIFICATION.md.
3. Automatic reconciliation of unconfirmed writes against Clover/audit (today: manual Re-check / Dismiss).
4. Persist tally and Undo across restarts; move the per-item lock and throttles to shared storage for multi-worker proxies.
5. Second location in the UI (routes are already location-scoped), then the purchasing module on the existing write path.
