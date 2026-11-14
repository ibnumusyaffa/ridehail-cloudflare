# Ride-Hailing POC — Cloudflare backend

Backend for the Gojek/Uber-style POC described in [PLAN.md](PLAN.md) (architecture: [ARCHITECTURE.md](ARCHITECTURE.md)), built on Cloudflare
Workers + Durable Objects, with Postgres (via Hyperdrive) as the system of record, as a Turborepo monorepo.

```
packages/core              pure logic, no I/O: geohash/haversine, matcher, ride state machine, fare, settlement
packages/client            shared client: typed REST client, WebSocket (reconnect/zone hand-over), message types, React map/UI
apps/api                   Worker (Hono REST + WebSocket gateway) + ZoneDO (zone actor) + Postgres (cold store)
apps/simulator-customer    customer web app (Vite + React + MapLibre/OpenFreeMap)   :5173
apps/simulator-driver      driver web app with autopilot driving                    :5174
apps/e2e                   Playwright: e2e tests + live demo driving both apps
```

## Quick start

Needs Docker (local Postgres on port 54329, databases `gojek`, `gojek_test`, `gojek_e2e`).

```sh
pnpm install
pnpm db:up                                # docker compose: Postgres 17
pnpm test                                 # turbo: core unit tests + api integration tests (in workerd, against gojek_test)

cd apps/api
cp .dev.vars.example .dev.vars            # JWT_SECRET for local dev
pnpm dev                                  # applies migrations to `gojek`, then http://localhost:8787
```

### Visual simulator (customer + driver side by side)

```sh
pnpm dev          # API :8787 + customer :5173 + driver :5174 (applies Postgres migrations)
```
Open http://localhost:5173 (customer) and http://localhost:5174 (driver) in two windows — different
ports, so separate sessions. Driver: pick a spot (or drag 🛵) → **Go online**. Customer: pick a route
(or click the map) → **Pesan**. Accept the offer on the driver side; autopilot drives the marker and you
press Tiba → Mulai → Selesai. Speed slider and autopilot toggle are on the driver's ride card.

```sh
pnpm demo:live                      # Playwright opens both windows and plays a full wallet ride, slowly
pnpm demo:live -- --trip gbk-blokm  # other preset: monas-hi | gbk-blokm | kota-ancol | kuningan-senopati
pnpm demo:record                    # same, saves videos to apps/e2e/videos/
pnpm e2e                            # Playwright e2e on an isolated stack (ports 8788/5273/5274, fresh gojek_e2e DB)
```

First time only: `pnpm --filter @gojek/e2e exec playwright install chromium`.

**Reset**: the 🔄 Reset button (top bar, both apps) calls `POST /dev/reset`, which wipes every user, ride,
wallet and zone actor. The other window logs out by itself (socket closed with 4002, or 401 on next request).
The endpoint exists only when the API runs with `DEV_RESET=1` (`.dev.vars`); in production it returns 404.

Road routes: both apps draw routes and the driver autopilot follows streets via OSRM
(`packages/client/src/route.ts`, default public server `router.project-osrm.org`, falls back to a straight
line on error). Override with `VITE_OSRM_URL=<your osrm>`, or `VITE_OSRM_URL=off` (used by `pnpm e2e`).
The backend fare still uses straight-line distance × 1.3 (PLAN §5.5).

Deploy: create a Postgres (Jakarta region), run `DATABASE_URL=<url> pnpm --filter @gojek/api db:migrate`,
`wrangler hyperdrive create gojek --connection-string=<url> --caching-disabled` → put the id in
`apps/api/wrangler.jsonc`, `wrangler secret put JWT_SECRET`, `pnpm deploy`.
Caching stays **disabled**: balances and active rides must never be read stale.

## How it maps to the plan

| Plan role | Implementation |
|---|---|
| API gateway | `apps/api/src/index.ts` — Hono; verifies JWT, routes `/ws` to the right zone |
| Zone actor | `ZoneDO` (`apps/api/src/zone.ts`), one per geohash zone (`ZONE_PRECISION`, default 5 ≈ 4.9 km) |
| Hot store | ZoneDO SQLite: driver status, active rides, timers, idempotency keys. Driver **positions live in memory** (+ a geohash-6 grid for matching), snapshotted to SQLite every 30 s |
| Timer | one DO alarm multiplexing a `timers` table (`dispatch:`, `offer:`, `search:`, `purge:`) |
| WebSocket | DO Hibernation API, sockets tagged `user:<id>`, `{"t":"ping"}` auto-answered without waking the DO |
| Cold store | Postgres via Hyperdrive (`apps/api/migrations`, `scripts/migrate.mjs`): users, vehicles, rides, wallets, wallet_transactions, wallet_holds |
| Wallet | Postgres transactions, see below |

### Zones and matching
- Ride id = `<zone>_<uuid>`, so any component can route to the ride's owner without a lookup.
- Search rings: geohash precision 6 cell + 8 neighbours (~±1.2 km), then precision 5 (~±5 km), max 5 km, top k=10.
  Each ring's cells are grouped by zone and queried in parallel (`nearest()` RPC); the local zone is a direct call.
- Offers are sequential: `reserveAndOffer()` RPC to the driver's zone is atomic (single writer) and fails if
  the driver is not AVAILABLE/connected → next candidate. 15 s offer timer, 20 s reservation TTL safety net.
  Queue exhausted → re-search once after `RESEARCH_DELAY_MS` → `NO_DRIVER`; hard limit `SEARCH_TIMEOUT_MS` (2 min).
- On accept the driver is **handed over to the ride's zone** for the trip (`zone.moved` → client reconnects
  with `zone=`), so customer + driver + ride live in one actor while the ride is active.
  AVAILABLE drivers who wander out of a zone get `zone.moved` and reconnect by location — once ≥ 100 m inside
  the new zone or after 3 consecutive pings outside (hysteresis, so GPS jitter on a border doesn't loop).
- Location pings: the server drops a ping that comes < 2 s (on a ride: < 1 s) after the last one *and* moved < 30 m;
  the driver app sends one only after moving 30 m or every 5 s. A ping only updates memory (no storage write).
- One active ride per customer is enforced by Postgres (partial unique index `one_active_ride`), so two
  orders racing in different zones can't both succeed. The ride row is inserted before dispatch starts.

### Wallet (atomic + idempotent)
- **Hold**: a WALLET order reserves the fare (`wallet_holds`) in the same transaction that inserts the ride;
  the order is refused (402) if `balance − active holds < fare`. Cancel / no driver releases the hold.
- **Settlement**: `settleRide()` in `apps/api/src/db.ts` is one transaction: it locks the ride row (`paid_at`
  marks it settled, so a retry is a no-op), locks both wallets in a fixed order, writes ledger rows
  (`UNIQUE(ride_id, user_id, type)`) and balances together, and captures the hold. Without a hold and with too
  little balance the ride falls back to CASH (driver owes commission). `wallets.balance == SUM(amount)` always holds.

Top-up uses `Idempotency-Key` (`UNIQUE(user_id, idempotency_key)`) in one transaction.
Driver below `DRIVER_MIN_BALANCE` cannot go online (and is set OFFLINE after a ride that pushes them below).

## API

REST (Bearer token): `POST /auth/login`, `GET /me`, `POST /rides/estimate`, `POST /rides` (`Idempotency-Key`),
`GET /rides?mine=1` (driver also gets `today` earnings), `GET /rides?active=1`, `GET /rides/:id`,
`POST /rides/:id/cancel`, `POST /rides/:id/rating`, `GET /wallet` (`{balance, held}`), `POST /wallet/topup`, `GET /wallet/transactions`.
Rate limits (Cloudflare Rate Limiting binding): `/auth/login` 20/min per IP, `/ws` 30 connects/min per user → 429.
Errors: `{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }`.

WebSocket `GET /ws?token=…`
- customer: `&rideId=` (or omitted → active ride)
- driver: `&lat=&lng=` (zone by location), or `&zone=` after a `zone.moved`, or `&rideId=` while on a ride.
- `&known=1`: sent by `RideSocket` on every reconnect after the first `hello` (it tracks its own active ride),
  so the gateway skips the database lookup — a deploy-wide reconnect storm costs no queries. Without it
  (cold start) the gateway looks up the active ride. Reconnects use exponential backoff with jitter.

Messages follow PLAN §9.2, plus:
`hello {zone, role, driverStatus?, rideId?}` on connect, `driver.state {status, rideId}`,
`zone.moved {zone, rideId?}` (reconnect, then send `resume`), `ride.status` carries the full `ride` view.

## Config (`apps/api/wrangler.jsonc` vars)
`ZONE_PRECISION` (≤5), `COMMISSION_RATE`, `DRIVER_MIN_BALANCE`, `OFFER_TIMEOUT_MS`, `RESERVE_TTL_MS`,
`SEARCH_TIMEOUT_MS`, `RESEARCH_DELAY_MS`, `TOPUP_MAX`, `LOC_MIN_INTERVAL_MS`, `LOC_MIN_INTERVAL_ON_RIDE_MS`,
`LOC_MIN_MOVE_M`, `HANDOFF_MARGIN_M`, `HANDOFF_PINGS`; secret `JWT_SECRET`. Fare constants: `packages/core/src/fare.ts`.

## Tests
- `packages/core`: geohash (incl. neighbours/poles/children), haversine, ping throttle, zone hysteresis, fare rounding, candidate ranking (busy/stale/rejected/radius/k),
  every valid & invalid state transition + idempotent duplicates, settlement (cash/wallet/fallback/rounding).
- `apps/api` (vitest + `@cloudflare/vitest-plugin`, real workerd/DO + Postgres `gojek_test`): full ride with reject → next driver → wallet payment,
  offer timeout, two rides racing for one driver, no driver, cancel while offering, driver cancel, cross-zone hand-over + reconnect,
  insufficient balance, top-up idempotency, double settlement, wallet → cash fallback, ledger invariant,
  one active ride across zones, wallet hold/release, border hysteresis, `known=1` reconnect without lookup.

- `apps/e2e` (Playwright, both apps in separate browser contexts): wallet ride end-to-end with rating & earnings,
  driver reject → NO_DRIVER, customer cancel during offer, driver page reload mid-ride resumes, insufficient balance.

## Next steps (out of POC scope)
Real payment gateway & driver withdrawal, OTP login, surge/promo, chat, KYC. Scalability roadmap: [TODO.md](TODO.md).
