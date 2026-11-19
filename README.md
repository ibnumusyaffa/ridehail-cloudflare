# Ride-Hailing Backend on Cloudflare

Backend for a ride-hailing app (think Uber or Gojek): customers book rides, nearby drivers get offers, and the
trip is tracked and paid for. It runs on Cloudflare Workers and Durable Objects, with Postgres as the source of
truth. Monorepo with Turborepo and pnpm.

Open work: [TODO.md](TODO.md).

```
packages/core              pure logic, no I/O: geohash, driver matching, ride state machine, fares, payments
packages/client            shared client: REST, WebSocket (reconnect, zone moves), message types, map and React UI
apps/api                   Worker (REST + WebSocket gateway), MatchDO and RideDO per zone, Postgres
apps/simulator-customer    customer web app (Vite + React + MapLibre)   :5173
apps/simulator-driver      driver web app with autopilot                :5174
apps/e2e                   Playwright end-to-end tests and live demo
```

## Quick start

Needs Docker (local Postgres on port 54329, databases `gojek`, `gojek_test`, `gojek_e2e`).

```sh
pnpm install
pnpm db:up                                         # Postgres 17 via docker compose
cp apps/api/.dev.vars.example apps/api/.dev.vars   # JWT_SECRET and DEV_RESET for local use
pnpm test                                          # core unit tests + api integration tests (gojek_test)
pnpm dev                                           # API :8787, customer :5173, driver :5174 (migrates on start)
```

Open http://localhost:5173 (customer) and http://localhost:5174 (driver) in two windows.

1. Driver: pick a location (or drag 🛵), then **Go online**.
2. Customer: pick a route (or click the map), then **Order**.
3. Driver: accept the offer. Autopilot drives to the pickup; press Arrived → Start → Complete.

Other commands:

```sh
pnpm demo:live                      # Playwright opens both apps and plays one full ride
pnpm demo:live -- --trip gbk-blokm  # other routes: monas-hi | gbk-blokm | kota-ancol | kuningan-senopati
pnpm demo:record                    # same, saves a video to apps/e2e/videos/
pnpm e2e                            # e2e tests on a separate stack (ports 8788/5273/5274, DB gojek_e2e)
pnpm typecheck
```

First time only: `pnpm --filter @gojek/e2e exec playwright install chromium`.

**Reset**: the 🔄 Reset button in both apps calls `POST /dev/reset`, which deletes all users, rides, balances
and zones. It only works when the API runs with `DEV_RESET=1`; otherwise it returns 404.

**Road routes**: the map and autopilot use the public OSRM server (`packages/client/src/route.ts`) and fall back
to a straight line if it fails. Point elsewhere with `VITE_OSRM_URL=<server>` or turn off with
`VITE_OSRM_URL=off`. Fares on the backend always use straight-line distance × 1.3.

## How it works

| Part | File | Role |
|---|---|---|
| Worker | `apps/api/src/index.ts` | Entry point. Checks the token, validates input, forwards to the right zone. |
| MatchDO | `apps/api/src/match.ts` | Driver search for one zone (`match:<zone>`, geohash 5, about 5 km). Holds free drivers (`OFFLINE`/`AVAILABLE`/`RESERVED`) and their positions, answers searches, reserves drivers. |
| RideDO | `apps/api/src/ride.ts` | Rides for one zone (`ride:<zone>`), or several shards for busy zones (`ride:<zone>.<k>`). Owns rides whose pickup is in that zone: dispatch, status, timers, route, payment; plus the sockets of the customer and the driver while `ON_RIDE`. |
| shared | `apps/api/src/actor.ts` | Base of both DOs: all timers on one alarm, sockets, driver positions, Postgres access. |
| shared | `apps/api/src/schema.ts` | Each DO's SQLite migrations (numbered, append-only). A DO runs the steps it hasn't run yet on startup, in one transaction. |
| Postgres | `apps/api/src/db.ts`, `apps/api/migrations` | Users, vehicles, ride history, balances, transactions, held funds. |

One ride:

```
Customer orders
  → Postgres records the ride (and holds the fare if paying by WALLET)
  → RideDO asks MatchDO (pickup zone + neighbours) and offers one driver at a time (15 s)
  → Accept → ACCEPTED → Arrived → ARRIVED → Start → ON_TRIP → Complete → COMPLETED
  → Payment is settled in Postgres
```

Ride status: `REQUESTED → OFFERING → ACCEPTED → ARRIVED → ON_TRIP → COMPLETED`, or `CANCELLED` / `NO_DRIVER`.
Driver status: `OFFLINE`, `AVAILABLE`, `RESERVED` (has an open offer), `ON_RIDE`.

### Zones and driver search

- Ride ID is `<home>_<uuid>`, where home is `<zone>` (shard 0) or `<zone>.<k>` (shard k). Anyone can tell which
  actor owns a ride without a lookup.
- **RideDO shards** for busy zones: `RIDE_SHARDS` (e.g. `qqguw=8,*=1`). New rides are spread by customer
  (`shardFor`, a hash of the customer id), so a retry with the same `Idempotency-Key` reaches the same shard.
  A ride stays on the shard in its ID, so the shard count can change at any time. All shards of a zone share
  one MatchDO (one pool of free drivers).
- Driver positions live **in memory** in the DO that holds the driver (plus a geohash-6 grid in MatchDO) and are
  copied to SQLite every 30 s. A location ping does not write to storage.
- Search: geohash-6 cell + 8 neighbours first; if empty, geohash-5 + 8 neighbours. At most 2 km from pickup
  (`maxRadiusM` in `packages/core/src/matcher.ts`, straight line), 10 nearest candidates. Neighbouring zones
  are asked in parallel.
- Offers go out one at a time. `reserveAndOffer` only succeeds for a connected `AVAILABLE` driver; otherwise the
  next candidate is tried. Offers last 15 s, reservations 20 s.
- Search ends (`NO_DRIVER`) after two empty results (5 s apart) or after 2 minutes.
- Once a driver accepts, they **move to the ride's RideDO** for the trip (the server sends `reconnect` with a
  `route` to that RideDO), so customer, driver and ride sit in one actor. On complete, cancel or driver drop,
  RideDO hands the driver back to the MatchDO of the zone they are in (`returnDriver`) and sends `reconnect`.
- During a move the server leaves the old socket open; the client closes it. Messages sent in between
  (`loc`, `ride.*`) are forwarded from MatchDO to RideDO, not lost.
- An `AVAILABLE` driver who leaves the zone is moved once they are ≥ 100 m inside the new zone or after 3 pings
  in a row outside. They arrive in the new zone still `AVAILABLE`.
- Location pings: the client sends one after moving ≥ 30 m or every 10 s. The server drops pings that arrive
  < 8 s apart (on a ride: < 1 s) **and** moved < 30 m, so an idle driver costs one ping every ~10 s. MatchDO
  drops them in memory before reading SQLite. Drivers silent for > 45 s are left out of searches.
- **At the right place**: a driver can mark Arrived only within `ARRIVE_MAX_DISTANCE_M` (200 m) of the pickup,
  and Complete only within `COMPLETE_MAX_DISTANCE_M` (300 m) of the dropoff, using their last known position.
  Otherwise the action fails with `TOO_FAR` and the distance. A repeated Complete stays an idempotent no-op.
- **Trip route**: `ON_TRIP` pings are thinned first (`sampleTrack`, `packages/core/src/track.ts`): one point
  every `TRACK_MIN_GAP_M` (200 m) or `TRACK_MAX_GAP_MS` (1 min), plus any point where the stored line would drift
  more than `TRACK_TOLERANCE_M` (25 m) from the driver (turns), plus the final position. Points are kept in
  RideDO's SQLite (`track`) and flushed to Postgres (`ride_track`) every `TRACK_FLUSH_MS` (1 min) and once more
  when the ride ends. If Postgres is down, points wait in RideDO; `seq` as the key prevents duplicates.
  Positions outside `ON_TRIP` are not stored.

### What Postgres guarantees

- One active ride per customer (`one_active_ride`) and per driver (`one_active_ride_driver`), across zones.
- `POST /rides` and top-ups are never applied twice, thanks to `Idempotency-Key`.
- **Balance**: a WALLET ride holds the fare (`wallet_holds`) in the same transaction that creates the ride, and is
  rejected (402) if the balance is too low. Cancel or no driver releases the hold.
- **Payment** (`settleRide`): one transaction, safe to retry. WALLET: customer pays, driver gets fare minus
  commission. CASH: driver owes the commission. `wallets.balance` always equals the sum of its transactions.
- Drivers below `DRIVER_MIN_BALANCE` can't go online.

### Ride status: Postgres first, then RideDO

- Every transition (accept, arrive, start, complete, cancel, `NO_DRIVER`) is checked by RideDO's state machine,
  written to Postgres in one transaction (compare-and-set on `rides.version`), and **only then** applied in
  RideDO and pushed over WebSocket. Cancel and `NO_DRIVER` release the held fare, and complete settles payment,
  all in that same transaction.
- If Postgres rejects it (e.g. the driver already has an active ride), RideDO follows Postgres and the action
  fails with a clear error.
- If Postgres is down or the reply is lost, the action returns `UNAVAILABLE` (503) and the status does not change.
  The transition is recorded as pending with a `sync:` timer **before** Postgres is called. That timer (or the
  next action) runs a *fence*: it bumps `version` from the expected value. Fence wins → the old write never
  committed. Fence loses → the write did commit and is applied now. So "rejected" always means "did not happen".
- Actions on one ride run one at a time, in arrival order.
- `OFFERING` exists only in RideDO; in Postgres a searching ride stays `REQUESTED`.

### Surviving database outages

- **Ride creation**: recorded as pending in RideDO before Postgres is called; if the outcome is unknown, a
  `create:` timer checks again.
- **Payment**: normally part of the complete transaction. If not (lost reply), a `settle:` timer retries until
  paid; the driver is freed right away.
- All timers (`dispatch:`, `offer:`, `search:`, `sync:`, `settle:`, `create:`, `watch:`, `track:`, `purge:`) share
  one DO alarm and a `timers` table. When a RideDO starts, timers for work still waiting on Postgres are re-armed.

## API

REST (Bearer token):

| Endpoint | Description |
|---|---|
| `POST /auth/login` | `{phone, role, name?}` → token. No OTP yet. |
| `GET /me` | user, vehicle, balance |
| `POST /rides/estimate` | distance and fare |
| `POST /rides` | create a ride (`Idempotency-Key`) |
| `GET /rides?mine=1` | history; drivers also get `today` earnings |
| `GET /rides?active=1` · `GET /rides/:id` | active ride / one ride |
| `POST /rides/:id/cancel` | cancel (drivers must give a reason) |
| `POST /rides/:id/rating` | 1–5 stars, customers only |
| `GET /wallet` · `POST /wallet/topup` · `GET /wallet/transactions` | balance `{balance, held}`, top-up (`Idempotency-Key` required), history |

Rate limits: `/auth/login` 20/min per IP, `/ws` 30 connections/min per user → 429.
Error format: `{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }`.

WebSocket `GET /ws?token=…`

- `&route=`: opaque string from the last `hello` / `reconnect` (`v1.m.<zone>` or `v1.r.<home>`, see `parseRoute`
  in `config.ts`). The client just stores it and sends it back, so the gateway skips the database. Unreadable
  routes are ignored.
- `&rideId=`: the ride a customer is watching (takes priority over route).
- Neither: the gateway looks up the active ride in Postgres; a driver without a ride is placed by `&lat=&lng=`.
- A stale route that reaches the wrong actor is corrected by that actor with `reconnect`.

Client messages: `online`, `offline`, `loc`, `offer.accept`, `offer.reject`, `ride.arrived`, `ride.start`,
`ride.complete`, `resume`, `ping`.
Server messages: `hello`, `driver.state`, `offer`, `offer.cancelled`, `ride.status`, `ride.paid`, `driver.loc`,
`reconnect`, `pong`, `error`.
Full definitions: `packages/client/src/protocol.ts`. Guide for native mobile clients: `apps/api/MOBILE-CLIENT.md`.

## Config (`apps/api/wrangler.jsonc`)

`ZONE_PRECISION` (≤ 5), `RIDE_SHARDS`, `COMMISSION_RATE`, `DRIVER_MIN_BALANCE`, `OFFER_TIMEOUT_MS`,
`RESERVE_TTL_MS`, `SEARCH_TIMEOUT_MS`, `RESEARCH_DELAY_MS`, `TOPUP_MAX`, `DRIVER_LOST_ASK_MS`,
`DRIVER_LOST_CANCEL_MS`, `TRACK_FLUSH_MS`, `LOC_MIN_INTERVAL_MS`, `LOC_MIN_INTERVAL_ON_RIDE_MS`, `LOC_MIN_MOVE_M`,
`HANDOFF_MARGIN_M`, `HANDOFF_PINGS`, `ARRIVE_MAX_DISTANCE_M`, `COMPLETE_MAX_DISTANCE_M`, `TRACK_MIN_GAP_M`, `TRACK_MAX_GAP_MS`, `TRACK_TOLERANCE_M`.
Secret: `JWT_SECRET`. Fare constants: `packages/core/src/fare.ts`.

## Tests

- `packages/core`: geohash, distance, ping throttle, zone hand-off, fares, candidate order, every status
  transition, payments.
- `apps/api` (vitest in workerd + Postgres `gojek_test`): full ride, reject → next driver, offer timeout, two rides
  racing for one driver, no driver, cancel, zone moves, low balance, no double top-up or payment, database outages.
- `apps/e2e` (Playwright): WALLET ride through to rating, driver rejects, customer cancels, driver reloads
  mid-ride, low balance.

## Deploy

1. Create a Postgres database (close to your users), then run
   `DATABASE_URL=<url> pnpm --filter @gojek/api db:migrate`.
2. `wrangler hyperdrive create gojek --connection-string=<url> --caching-disabled` and put its id in
   `apps/api/wrangler.jsonc`.
3. `wrangler secret put JWT_SECRET`.
4. `pnpm --filter @gojek/api deploy`.

Hyperdrive caching must stay **off**: balances and active rides must never be read stale. Never set `DEV_RESET`
in production.

## Not built yet

OTP login, payment gateway and driver payouts, surge pricing and promos, chat, KYC, admin panel.
Known logic gaps and their order are in [TODO.md](TODO.md).
