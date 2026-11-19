# TODO

Order: **ride-hailing logic for an MVP first**, scale later.

An item is done only when it has a test in `apps/api/test/` (or `apps/e2e/tests/`).

Priority levels:

- **P0**: broken data, or a user locked out forever.
- **P1**: wrong result, or something a user can cheat.
- **P2**: small fixes and user experience.

---

## Open

### P1: Wrong result or cheatable

- [ ] **A9. Customer no-show**
  - Today a driver who has `ARRIVED` can only give the ride back (`REQUEUE`). The ride then searches for another
    driver for a customer who is not there (up to `MAX_REQUEUES` times). The waiting driver is counted as a
    dropout and gets nothing.
  - Add a new event, e.g. `CANCEL` by `driver` with reason `no_show`. Allowed only from `ARRIVED`, and only after
    the driver has waited `NO_SHOW_WAIT_MS` since `arrivedAt` (config). The ride ends (no new search) and the
    driver is not counted as a dropout.
  - Decide: the no-show fee (taken from the WALLET hold; for CASH, a customer debt or waived?) and the driver's share.
  - Reuse the A5 location check: the driver must really be near the pickup to claim a no-show.
  - Done when: a driver at the pickup who waited past the limit can cancel as no-show, the ride is not searched
    again and the driver is not a dropout; before the limit the request fails with a clear error.

- [ ] **A10. A trip cannot end halfway**
  - Today `ON_TRIP` ends only with `COMPLETE` (full fare), or when the driver goes silent for
    `DRIVER_LOST_ASK_MS` (1 h, then the customer may report) or `DRIVER_LOST_CANCEL_MS` (3 h). A flat tyre, an
    accident, or a customer getting out early has no path, and the customer stays locked (one active ride) for
    up to 1 h.
  - Options (business decision needed):
    - Driver or customer can "end trip here": `COMPLETE` with a partial fare (from the `ride_track` route, or
      straight line to the last point), so `fareFinal` ≤ `fare`.
    - Let the customer report a problem sooner (lower `DRIVER_LOST_ASK_MS`, e.g. 10–15 min without pings).
    - Admin endpoints to force-complete or force-cancel (needs admin auth).
  - Done when: a trip can end halfway with a fair fare, and a customer is never locked longer than the agreed limit.

- [ ] **Driver stuck in `ACCEPTED`**: a driver can accept and never arrive. The customer can still cancel, but
  nothing ends the ride on its own.

### P2: Small fixes

- [ ] **A7. Input validation for `POST /rides`**: reject trips above a maximum distance, and pickup equal to
  dropoff. (Ride ids in `/ws?rideId=` and `/rides/:id/*` are already checked by `validHome`.)
- [ ] **Small notes from review**
  - A driver whose socket drops stays `AVAILABLE` for up to 1 h, and the balance is not checked again on reconnect.
  - `GET /rides/:id` (Postgres) shows `REQUESTED` while the WebSocket (RideDO) shows `OFFERING`.
  - `purge` does not remove expired `RESERVED` drivers.
  - Worker queries outside a transaction have no client-side timeout (only Hyperdrive's 60 s).
- [ ] **Split `ride.ts`** (~1,300 lines) into dispatch, transitions and payment, with no behaviour change.

## Before real users and real money

- [ ] **B1. OTP login**: today anyone can log in with any phone number.
- [ ] **B3. First deploy**: make sure both DOs use Hyperdrive in production, not only the Worker.
- [ ] **B4. Payment gateway and driver payouts.**
- [ ] **Driver cancel audit**: drivers who give a ride back are tracked only in the DO (`dropoutDrivers`).
  Penalties or a cancel rate need an audit table in Postgres.

## Scale (wait for real load)

Do not start before the items above are done and there are measurements.

- [ ] **C1. Load test**: 1k → 5k drivers in one zone. Record offer latency, DO duration, rows written, Postgres
  connections. Also gives the metric to pick which zones need more ride shards.
- [ ] **C2. Write Postgres through Queues**: only if C1 shows Postgres writes are the bottleneck. Ride status
  stays a direct write; this is for non-critical data (history, stats).
- [ ] **C4. Road ETA and batch matching**: a separate service; MatchDO keeps straight-line distance as a fallback.
- [ ] **C5. Adaptive zones, partitioned `rides` table, read replicas.** Adaptive zones are on hold: smaller zones
  mean more zone moves for roaming drivers and more DOs per search. MatchDO works almost fully in memory, so
  decide after C1.

### Cost rules (keep these when refactoring)

Rough numbers for 10k online drivers, 100k rides a day, one ping every 5 s.

- **Never write DO SQLite on every location ping.** ≈ $5,000/month.
- **Never create one DO per ride.** ≈ $7,000/month. Use fixed shards.
- **Never forward every ping through DO-to-DO RPC.** The driver's socket goes straight to the DO that owns its state.

---

## Done

Each line names the test that proves it.

- **A1. Postgres timeouts**: 5 s connect, 8 s per operation, 5 s statement timeout inside transactions. A slow
  Postgres fails fast instead of hanging every action.
- **A2. Ride status: Postgres first, then the DO.** Every transition is one Postgres transaction with
  compare-and-set on `rides.version`; payment settles in the same transaction. If Postgres fails or the reply is
  lost, a *fence* (`fenceRide`) bumps the version so an old write can never commit later. "Rejected" always means
  "did not happen". Actions on one ride run in order. `resilience.test.ts`
- **A3. `ON_TRIP` never stuck forever**: a driver silent for 1 h triggers a question to the customer (arrived or
  cancel); 3 h with no answer cancels and releases the hold. `driver-lost.test.ts`
- **A4. Reliable driver search**: a guard timer before every step that can fail, offers written before the
  reserve RPC, retries on the same driver then the next one, failed zones skipped, timers restored after a
  restart. `dispatch.test.ts`
- **A5. Location check for Arrived and Complete**: within 200 m of the pickup and 300 m of the dropoff, otherwise
  `TOO_FAR` with the distance. A repeated Complete stays an idempotent no-op. `at-place.test.ts`
- **A6. A driver never has two rides**: a partial unique index in Postgres, a handover timer when an accept
  commits but the driver's zone did not hear about it, and `online` sends a driver with an active ride back to
  it. `resilience.test.ts`
- **A8. Driver cancels → find another driver** (`REQUEUE`). The hold stays; after `MAX_REQUEUES` (3) the ride is
  cancelled and the hold released. `requeue.test.ts`
- **B2. Two DOs per zone**: `MatchDO` (free drivers, search) and `RideDO` (rides, drivers on a ride).
- **C3. Ride shards for busy zones** (`RIDE_SHARDS`), picked by customer hash so retries land on the same shard;
  the shard count can change while rides are running. `shard.test.ts`
- **Lost replies on the client**: `Idempotency-Key` kept per order and per top-up until success; lost replies and
  5xx are retried with the same key. `apps/e2e/tests/ride.spec.ts`
- **Trip route**: pings thinned and stored, flushed to Postgres without duplicates. `track.test.ts`
- **Wallet**: hold → capture / release; payments and top-ups safe to retry. `wallet.test.ts`
- Postgres as the source of truth (moved from D1), one active ride per customer and per driver.
- Driver positions in memory with a geohash-6 grid, saved to SQLite every 30 s; location ping throttling
  (`ping-throttle.test.ts`); zone moves with hysteresis; reconnect with jitter.
- WebSocket connect with no database query; daily driver earnings with SQL aggregates; rate limits on login and
  WebSocket.
