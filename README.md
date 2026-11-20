# Ride-Hailing Backend on Cloudflare

Backend for a ride-hailing app (think Uber or Gojek): customers book rides, nearby drivers get offers, and the
trip is tracked and paid for. Cloudflare Workers and Durable Objects, with Postgres as the source of truth.
Monorepo with Turborepo and pnpm. Open work: [TODO.md](TODO.md).

```
packages/core              pure logic, no I/O: geohash, matching, ride state machine, fares, payments
packages/client            shared client: REST, WebSocket, message types, map and React UI
apps/api                   Worker (REST + WebSocket gateway), MatchDO and RideDO per zone, Postgres
apps/simulator-customer    customer web app   :5173
apps/simulator-driver      driver web app with autopilot   :5174
apps/e2e                   Playwright end-to-end tests and live demo
```

## Quick start

Needs Docker (Postgres on port 54329).

```sh
pnpm install
pnpm db:up                                         # Postgres 17
cp apps/api/.dev.vars.example apps/api/.dev.vars   # JWT_SECRET, DEV_RESET
pnpm test                                          # unit + integration tests
pnpm dev                                           # API :8787, customer :5173, driver :5174
```

Open both apps. Driver: **Go online**. Customer: pick a route, **Order**. Driver: accept; autopilot drives, then
Arrived → Start → Complete.

```sh
pnpm demo:live      # Playwright plays one full ride in both apps (--trip gbk-blokm for another route)
pnpm e2e            # e2e tests on a separate stack (first time: pnpm --filter @gojek/e2e exec playwright install chromium)
pnpm typecheck
```

🔄 Reset in either app wipes all data (`POST /dev/reset`, only with `DEV_RESET=1`). Map routes come from the
public OSRM server (`VITE_OSRM_URL` to change, `off` to disable); fares always use straight-line distance × 1.3.

## How it works

| Part | File | Role |
|---|---|---|
| Worker | `apps/api/src/index.ts` | Checks the token, validates input, forwards to the right zone. |
| MatchDO | `apps/api/src/match.ts` | One per zone (geohash 5, ~5 km): free drivers and their positions, search, reservations. |
| RideDO | `apps/api/src/ride.ts` | One per zone, or several shards for busy zones: dispatch, status, timers, route, payment, and the sockets of a ride's customer and driver. |
| shared | `apps/api/src/actor.ts`, `schema.ts` | Base of both DOs (timers on one alarm, sockets, positions) and their SQLite migrations. |
| Postgres | `apps/api/src/db.ts`, `migrations/` | Users, rides, balances, transactions, held funds. |

```
Customer orders → Postgres records the ride (and holds the fare for WALLET)
  → RideDO asks MatchDO (pickup zone + neighbours), offers one driver at a time (15 s)
  → ACCEPTED → ARRIVED → ON_TRIP → COMPLETED → payment settled in Postgres
```

Ride: `REQUESTED → OFFERING → ACCEPTED → ARRIVED → ON_TRIP → COMPLETED`, or `CANCELLED` / `NO_DRIVER`.
Driver: `OFFLINE`, `AVAILABLE`, `RESERVED`, `ON_RIDE`.

### Zones and dispatch

- Ride ID is `<zone>[.<shard>]_<uuid>`, so the owning actor is known without a lookup. Busy zones split rides
  over shards (`RIDE_SHARDS`, e.g. `qqguw=8,*=1`), picked by customer hash; all shards share one MatchDO.
- Driver positions live in memory (plus a geohash-6 grid) and are saved every 30 s; a ping never writes storage.
  The server drops pings that come too soon and moved too little, so an idle driver costs one ping per ~10 s.
- Search: nearest 10 within 2 km, nearby cells first, neighbouring zones in parallel. Offers last 15 s; the
  search ends with `NO_DRIVER` after two empty rounds or 2 minutes.
- On accept the driver's socket moves to the ride's RideDO, so customer, driver and ride share one actor; when
  the ride ends the driver goes back to the MatchDO of their current zone. Messages sent mid-move are forwarded.
- Arrived only within 200 m of the pickup, Complete only within 300 m of the dropoff (`TOO_FAR` otherwise).
- The trip route is thinned (one point per 200 m / 1 min, plus turns) and flushed to Postgres every minute.

### Postgres first

- Postgres enforces one active ride per customer and per driver, and `Idempotency-Key` on orders and top-ups.
- A WALLET ride holds the fare in the same transaction that creates it (402 if the balance is too low); cancel or
  `NO_DRIVER` releases it. Payment settles in one transaction, safe to retry.
- Every status change is checked by RideDO, written to Postgres in one transaction (compare-and-set on
  `rides.version`), and only then applied in RideDO and pushed to the apps.
- If Postgres is down or the reply is lost, the action returns `UNAVAILABLE` and nothing changes. A pending
  record and a `sync:` timer resolve it later with a *fence* (bump the version): either the old write never
  commits, or it did and is applied now. "Rejected" always means "did not happen".
- All timers share one DO alarm and are re-armed when a RideDO starts.

## API

REST, Bearer token:

| Endpoint | Description |
|---|---|
| `POST /auth/login` | `{phone, role, name?}` → token (no OTP yet) |
| `GET /me` | user, vehicle, balance |
| `POST /rides/estimate` | distance and fare |
| `POST /rides` | create a ride (`Idempotency-Key`) |
| `GET /rides?mine=1` · `?active=1` · `/rides/:id` | history, active ride, one ride |
| `POST /rides/:id/cancel` · `/rating` | cancel (drivers give a reason), rate 1–5 |
| `GET /wallet` · `/wallet/transactions` · `POST /wallet/topup` | balance, history, top-up (`Idempotency-Key`) |

Errors: `{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }`

WebSocket: `GET /ws?token=…`. Messages are in `packages/client/src/protocol.ts`; guide for native clients in
`apps/api/MOBILE-CLIENT.md`. Config: `apps/api/wrangler.jsonc`.

## Deploy

1. Create Postgres, then `DATABASE_URL=<url> pnpm --filter @gojek/api db:migrate`.
2. `wrangler hyperdrive create gojek --connection-string=<url> --caching-disabled`, put the id in `wrangler.jsonc`.
3. `wrangler secret put JWT_SECRET`, then `pnpm --filter @gojek/api deploy`.

Keep Hyperdrive caching **off** (balances must never be stale) and never set `DEV_RESET` in production.

## Not built yet

OTP login, payment gateway and driver payouts, surge pricing, chat, KYC, admin panel. See [TODO.md](TODO.md).
