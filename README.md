# Ride-Hailing POC — Cloudflare backend

Backend for the Gojek/Uber-style POC described in [PLAN.md](PLAN.md) (architecture: [ARCHITECTURE.md](ARCHITECTURE.md)), built on Cloudflare
Workers + Durable Objects + D1, as a Turborepo monorepo.

```
packages/core              pure logic, no I/O: geohash/haversine, matcher, ride state machine, fare, settlement
packages/client            shared client: typed REST client, WebSocket (reconnect/zone hand-over), message types, React map/UI
apps/api                   Worker (Hono REST + WebSocket gateway) + ZoneDO (zone actor) + D1 (cold store)
apps/simulator-customer    customer web app (Vite + React + MapLibre/OpenFreeMap)   :5173
apps/simulator-driver      driver web app with autopilot driving                    :5174
apps/e2e                   Playwright: e2e tests + live demo driving both apps
```

## Quick start

```sh
pnpm install
pnpm test                                 # turbo: core unit tests + api integration tests (in workerd)

cd apps/api
cp .dev.vars.example .dev.vars            # JWT_SECRET for local dev
pnpm db:migrate:local
pnpm dev                                  # http://localhost:8787

```

### Visual simulator (customer + driver side by side)

```sh
pnpm dev          # API :8787 + customer :5173 + driver :5174 (applies local D1 migrations)
```
Open http://localhost:5173 (customer) and http://localhost:5174 (driver) in two windows — different
ports, so separate sessions. Driver: pick a spot (or drag 🛵) → **Go online**. Customer: pick a route
(or click the map) → **Pesan**. Accept the offer on the driver side; autopilot drives the marker and you
press Tiba → Mulai → Selesai. Speed slider and autopilot toggle are on the driver's ride card.

```sh
pnpm demo:live                      # Playwright opens both windows and plays a full wallet ride, slowly
pnpm demo:live -- --trip gbk-blokm  # other preset: monas-hi | gbk-blokm | kota-ancol | kuningan-senopati
pnpm demo:record                    # same, saves videos to apps/e2e/videos/
pnpm e2e                            # Playwright e2e on an isolated stack (ports 8788/5273/5274, fresh DB)
```

First time only: `pnpm --filter @gojek/e2e exec playwright install chromium`.

**Reset**: the 🔄 Reset button (top bar, both apps) calls `POST /dev/reset`, which wipes every user, ride,
wallet and zone actor. The other window logs out by itself (socket closed with 4002, or 401 on next request).
The endpoint exists only when the API runs with `DEV_RESET=1` (`.dev.vars`); in production it returns 404.

Road routes: both apps draw routes and the driver autopilot follows streets via OSRM
(`packages/client/src/route.ts`, default public server `router.project-osrm.org`, falls back to a straight
line on error). Override with `VITE_OSRM_URL=<your osrm>`, or `VITE_OSRM_URL=off` (used by `pnpm e2e`).
The backend fare still uses straight-line distance × 1.3 (PLAN §5.5).

Deploy: `wrangler d1 create gojek-clone` → put the id in `apps/api/wrangler.jsonc`,
`wrangler secret put JWT_SECRET`, `pnpm db:migrate:remote`, `pnpm deploy`.

## How it maps to the plan

| Plan role | Implementation |
|---|---|
| API gateway | `apps/api/src/index.ts` — Hono; verifies JWT, routes `/ws` to the right zone |
| Zone actor | `ZoneDO` (`apps/api/src/zone.ts`), one per geohash zone (`ZONE_PRECISION`, default 5 ≈ 4.9 km) |
| Hot store | ZoneDO SQLite: drivers (soft state, location), active rides, timers, idempotency keys |
| Timer | one DO alarm multiplexing a `timers` table (`dispatch:`, `offer:`, `search:`, `purge:`) |
| WebSocket | DO Hibernation API, sockets tagged `user:<id>`, `{"t":"ping"}` auto-answered without waking the DO |
| Cold store | D1 (`apps/api/migrations`): users, vehicles, rides, wallets, wallet_transactions |
| Wallet | D1 `batch()` (single transaction), see below |

### Zones and matching
- Ride id = `<zone>_<uuid>`, so any component can route to the ride's owner without a lookup.
- Search rings: geohash precision 6 cell + 8 neighbours (~±1.2 km), then precision 5 (~±5 km), max 5 km, top k=10.
  Each ring's cells are grouped by zone and queried in parallel (`nearest()` RPC); the local zone is a direct call.
- Offers are sequential: `reserveAndOffer()` RPC to the driver's zone is atomic (single writer) and fails if
  the driver is not AVAILABLE/connected → next candidate. 15 s offer timer, 20 s reservation TTL safety net.
  Queue exhausted → re-search once after `RESEARCH_DELAY_MS` → `NO_DRIVER`; hard limit `SEARCH_TIMEOUT_MS` (2 min).
- On accept the driver is **handed over to the ride's zone** for the trip (`zone.moved` → client reconnects
  with `zone=`), so customer + driver + ride live in one actor while the ride is active.
  AVAILABLE drivers who wander out of a zone get `zone.moved` and reconnect by location.

### Wallet settlement (atomic + idempotent)
`settleRide()` in `apps/api/src/db.ts` is one D1 batch:
- every ledger insert is guarded by `rides.paid_at IS NULL` and `UNIQUE(ride_id, user_id, type)`;
- every balance update is guarded by the existence of the ledger row inserted by *that* run,
  so `wallets.balance == SUM(wallet_transactions.amount)` always holds;
- wallet charge is `WHERE balance >= fare`; otherwise the ride falls back to CASH (driver owes commission).

Top-up uses `Idempotency-Key` (`UNIQUE(user_id, idempotency_key)`), same guarded pattern.
Driver below `DRIVER_MIN_BALANCE` cannot go online (and is set OFFLINE after a ride that pushes them below).

## API

REST (Bearer token): `POST /auth/login`, `GET /me`, `POST /rides/estimate`, `POST /rides` (`Idempotency-Key`),
`GET /rides?mine=1` (driver also gets `today` earnings), `GET /rides?active=1`, `GET /rides/:id`,
`POST /rides/:id/cancel`, `POST /rides/:id/rating`, `GET /wallet`, `POST /wallet/topup`, `GET /wallet/transactions`.
Errors: `{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }`.

WebSocket `GET /ws?token=…`
- customer: `&rideId=` (or omitted → active ride)
- driver: `&lat=&lng=` (zone by location), or `&zone=` after a `zone.moved`; an active ride wins.

Messages follow PLAN §9.2, plus:
`hello {zone, role, driverStatus?, rideId?}` on connect, `driver.state {status, rideId}`,
`zone.moved {zone, rideId?}` (reconnect, then send `resume`), `ride.status` carries the full `ride` view.

## Config (`apps/api/wrangler.jsonc` vars)
`ZONE_PRECISION` (≤5), `COMMISSION_RATE`, `DRIVER_MIN_BALANCE`, `OFFER_TIMEOUT_MS`, `RESERVE_TTL_MS`,
`SEARCH_TIMEOUT_MS`, `RESEARCH_DELAY_MS`, `TOPUP_MAX`; secret `JWT_SECRET`. Fare constants: `packages/core/src/fare.ts`.

## Tests
- `packages/core`: geohash (incl. neighbours/poles), haversine, fare rounding, candidate ranking (busy/stale/rejected/radius/k),
  every valid & invalid state transition + idempotent duplicates, settlement (cash/wallet/fallback/rounding).
- `apps/api` (vitest + `@cloudflare/vitest-plugin`, real workerd/DO/D1): full ride with reject → next driver → wallet payment,
  offer timeout, two rides racing for one driver, no driver, cancel while offering, driver cancel, cross-zone hand-over + reconnect,
  insufficient balance, top-up idempotency, double settlement, wallet → cash fallback, ledger invariant.

- `apps/e2e` (Playwright, both apps in separate browser contexts): wallet ride end-to-end with rating & earnings,
  driver reject → NO_DRIVER, customer cancel during offer, driver page reload mid-ride resumes, insufficient balance.

## Next steps (out of POC scope)
Real payment gateway & driver withdrawal, OTP login, surge/promo, chat, KYC, batch matching, OSRM road ETA, load test.
