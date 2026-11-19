import {
  applyRideEvent,
  type Candidate,
  DomainError,
  type DriverStatus,
  endTrack,
  estimate,
  haversineM,
  type PaymentMethod,
  type Place,
  type RideEvent,
  type RideStatus,
  type Role,
  sampleTrack,
  searchCells,
  type TrackPt,
  type TrackState,
} from "@gojek/core";
import { type PingDriver, PURGE_EVERY_MS, retryDelay, type SocketMeta, ZoneActor } from "./actor";
import { homeOfRide, matchRoute, matchStub, rideRoute, zoneOfKey } from "./config";
import * as db from "./db";
import type { MatchApi } from "./match";
import { type ClientMsg, type DriverInfo, fail, type OfferPayload, type Result, type RideView, type ServerMsg } from "./protocol";
import { RIDE_MIGRATIONS } from "./schema";

/** Hot ride state: the client view plus dispatch internals. */
interface HotRide extends RideView {
  idempotencyKey: string | null;
  queue: (Candidate & { zone: string })[];
  rejected: string[];
  /**
   * The driver this ride is offered to. `reserving`: written before the `reserveAndOffer` RPC, whose
   * outcome is unknown until it returns — if it threw or this actor died, the next dispatch step
   * retries the same driver (the reservation is idempotent) up to RESERVE_TRIES times.
   */
  offer: { driverId: string; zone: string; expiresAt: number; reserving?: boolean; tries?: number } | null;
  searchDeadline: number;
  /** written to this actor, Postgres insert not confirmed yet (see createRide / recoverCreate) */
  pgPending?: boolean;
  /** a status change sent to Postgres whose outcome is not known yet (see commit / push) */
  pending?: PendingTransition;
  /** Postgres `rides.version` as of this actor's last write / read */
  pgVersion?: number;
  /** failed settlement attempts (retried by the `settle:` timer) */
  settleAttempts?: number;
  /** ON_TRIP and the driver went silent: the customer was asked what happened (see `watchDriver`) */
  driverLostAt?: number;
  /** drivers who accepted this ride, then dropped it (REQUEUE); each one is also in `rejected` */
  dropoutDrivers?: string[];
  /**
   * The accept committed while the driver is registered in another zone: that zone is told (the
   * `handover:` timer, retried) so it stops treating the driver as free once their reservation lapses.
   */
  handover?: { zone: string; driverId: string; attempts: number };
}

/** The fields of a ride a driver's location ping reads (see `RideDO.heads`). */
type RideHead = Pick<HotRide, "id" | "status" | "customerId" | "driverLostAt">;
const headOf = (r: HotRide): RideHead => ({ id: r.id, status: r.status, customerId: r.customerId, driverLostAt: r.driverLostAt });

/**
 * A ride transition on its way to Postgres. The ride's status in this actor only changes once
 * Postgres has committed it; until then this records what was asked, so it can be re-sent.
 */
interface PendingTransition {
  id: string;
  event: RideEvent["type"];
  /** the ride as it will be once committed (only the Postgres-owned fields matter) */
  next: RideView;
  /** the Postgres row version the write expects (compare-and-set) */
  base: number;
  attempts: number;
}

/** Facts a transition's side effects need that only the caller knows (absent on the recovery path). */
interface CommitCtx {
  driverPos?: { lat: number | null; lng: number | null; heading: number | null };
}

/** Ride fields Postgres owns: they change here only after Postgres committed them. */
const PG_FIELDS = [
  "status", "driverId", "driver", "fareFinal", "cancelReason", "cancelledBy",
  "acceptedAt", "arrivedAt", "startedAt", "completedAt", "cancelledAt",
] as const;

/** The event that leads to each status (used to adopt a status Postgres has and this actor does not). */
const EVENT_FOR: Partial<Record<RideStatus, RideEvent["type"]>> = {
  REQUESTED: "REQUEUE",
  ACCEPTED: "ACCEPT", ARRIVED: "ARRIVE", ON_TRIP: "START", COMPLETED: "COMPLETE", CANCELLED: "CANCEL", NO_DRIVER: "NO_CANDIDATE",
};

/** The customer's answer when the driver went silent mid-trip: "we arrived" or "something went wrong". */
export type DriverLostAction = "arrived" | "cancel";

export interface CreateRideInput {
  customerId: string;
  pickup: Place;
  dropoff: Place;
  paymentMethod: PaymentMethod;
  idempotencyKey: string | null;
}

/** Methods match actors / the Worker call over RPC. Results never throw across the wire. */
export interface RideApi {
  /** `home`: the ride actor this call reached (a zone or one of its shards, see `rideHome`) */
  createRide(home: string, input: CreateRideInput): Promise<Result<{ ride: RideView }>>;
  cancelRide(rideId: string, userId: string, role: Role, reason: string): Promise<Result<{ ride: RideView }>>;
  acceptOffer(rideId: string, driver: DriverInfo & { lat: number | null; lng: number | null; heading: number | null }): Promise<Result<{ ride: RideView }>>;
  offerRejected(rideId: string, driverId: string): Promise<void>;
  driverLost(rideId: string, customerId: string, action: DriverLostAction): Promise<Result<{ ride: RideView }>>;
  /** a driver's arrive / start / complete that reached the match actor (sent just after accepting) */
  driverRideEvent(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<Result>;
  /** same, for a location ping */
  driverLoc(driverId: string, rideId: string, loc: { lat: number; lng: number; heading?: number }): Promise<void>;
  /** the ride, for one of its participants */
  rideOf(rideId: string, userId: string): Promise<RideView | null>;
  reset(): Promise<void>;
}

/** Searching statuses. OFFERING lives only in this actor; Postgres keeps such a ride REQUESTED. */
const ACTIVE_DISPATCH = new Set(["REQUESTED", "OFFERING"]);
const KEEP_TERMINAL_MS = 60 * 60_000;
/** route points sent to Postgres per insert (a minute of a trip is ~15) */
const TRACK_BATCH = 500;
const ALARM_CONCURRENCY = 16;
/** a ride still pgPending (or with a pending transition) after this long is checked against Postgres */
const CREATE_RECOVERY_MS = 5_000;
/** a dispatch step that did not reach a resting state (RPC failed, actor died) is run again after this */
const DISPATCH_RETRY_MS = 2_000;
/** attempts to reserve one candidate whose `reserveAndOffer` RPC failed before moving on to the next */
const RESERVE_TRIES = 3;
/**
 * The ride's zone tells the driver's zone about a committed accept this long after it. The driver's
 * own accept usually moves them first (it got the reply); this is for when that reply never came.
 */
const HANDOVER_DELAY_MS = 1_000;

/**
 * Ride actor (`ride:<home>`): single writer for the rides whose pickup is in one geohash zone, from
 * order to payment — dispatch (asking match actors for drivers), status transitions (Postgres first),
 * timers, the trip route — plus the sockets of its customers and of its drivers while ON_RIDE.
 *
 * Free drivers live in the match actors (`match:<zone>`). The driver who accepts moves here for the
 * trip (their pings feed the customer's map and the route) and goes back (`returnDriver`) when it ends.
 *
 * A busy zone has several ride actors (shards): home = `<zone>` for shard 0, `<zone>.<k>` for shard k
 * (`RIDE_SHARDS`). Each ride stays in the shard its id names; shards share nothing but the zone's
 * match actors, so splitting a zone's rides needs no coordination between them.
 */
export class RideDO extends ZoneActor implements RideApi {
  /** drivers here are ON_RIDE: the on-ride ping interval */
  protected readonly ridePings = true;
  /** rides whose Postgres insert is in flight right now */
  private creating = new Set<string>();
  /** per-ride queue: actions that change a ride's status run one at a time, in arrival order */
  private lanes = new Map<string, Promise<unknown>>();
  /** rides whose pending transition is being sent to Postgres right now (callers share the answer) */
  private committing = new Map<string, Promise<Result<{ ride: HotRide; changed: boolean }>>>();
  /** rides with a settlement call in flight (the inline attempt and the timer must not overlap) */
  private settling = new Set<string>();
  /**
   * route sampler per ON_TRIP ride. Memory only: after an eviction the next ping just starts a new
   * run (one extra point), and at worst the held-back last ping of the trip is lost.
   */
  private tracks = new Map<string, TrackState>();
  /**
   * What a location ping needs of a ride, kept in step by `saveRide` (memory only, filled lazily):
   * a ping then costs no `rides` read and no JSON parse of the whole ride.
   */
  private heads = new Map<string, RideHead>();

  protected migrations() {
    return RIDE_MIGRATIONS;
  }

  /** Work that waits on Postgres or another actor must always have its timer (see ZoneActor.rearmTimers). */
  protected override async rearmTimers() {
    const now = Date.now();
    const rows = this.sql
      .exec<{ id: string; kind: string }>(
        `SELECT id, CASE
           WHEN json_extract(data, '$.pgPending') = 1 THEN 'create'
           WHEN json_extract(data, '$.pending') IS NOT NULL THEN 'sync'
           ELSE 'settle' END AS kind
         FROM rides
         WHERE json_extract(data, '$.pgPending') = 1 OR json_extract(data, '$.pending') IS NOT NULL
            OR (status = 'COMPLETED' AND json_extract(data, '$.paidAt') IS NULL)`,
      )
      .toArray();
    for (const r of rows) this.sql.exec("INSERT OR IGNORE INTO timers (key, at) VALUES (?, ?)", `${r.kind}:${r.id}`, now);
    // every trip is watched for a driver gone silent
    this.sql.exec("INSERT OR IGNORE INTO timers (key, at) SELECT 'watch:' || id, ? FROM rides WHERE status = 'ON_TRIP'", now);
    // every trip route reaches Postgres (a flush that was running when this actor died left no timer behind)
    this.sql.exec(
      `INSERT OR IGNORE INTO timers (key, at) SELECT 'track:' || id, ? FROM
         (SELECT id FROM rides WHERE status = 'ON_TRIP' UNION SELECT ride_id FROM track)`,
      now,
    );
    // every search goes on (a step that was running when this actor died left no timer behind)
    this.sql.exec(
      `INSERT OR IGNORE INTO timers (key, at) SELECT 'dispatch:' || id, ? FROM rides
       WHERE status IN ('REQUESTED', 'OFFERING') AND json_extract(data, '$.pending') IS NULL
         AND json_extract(data, '$.pgPending') IS NOT 1`,
      now,
    );
    // A timer row is deleted before its handler runs, so one that was running when this actor died is
    // gone. A standing offer always has its timeout (dispatch skips a ride with a standing offer, so
    // nothing else would ever move it on) and every search has its deadline.
    this.sql.exec(
      `INSERT OR IGNORE INTO timers (key, at) SELECT 'offer:' || id, json_extract(data, '$.offer.expiresAt') FROM rides
       WHERE status = 'OFFERING' AND json_extract(data, '$.offer') IS NOT NULL
         AND json_extract(data, '$.offer.reserving') IS NOT 1`,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO timers (key, at) SELECT 'search:' || id, json_extract(data, '$.searchDeadline') FROM rides
       WHERE status IN ('REQUESTED', 'OFFERING') AND json_extract(data, '$.pgPending') IS NOT 1`,
    );
    // every accept the driver's match actor has not heard of yet
    this.sql.exec(
      "INSERT OR IGNORE INTO timers (key, at) SELECT 'handover:' || id, ? FROM rides WHERE json_extract(data, '$.handover') IS NOT NULL",
      now,
    );
    await super.rearmTimers();
  }

  override async reset(): Promise<void> {
    await super.reset();
    this.creating.clear();
    this.committing.clear();
    this.lanes.clear();
    this.settling.clear();
    this.heads.clear();
  }

  private stub(zone: string): MatchApi {
    return matchStub(this.env, zone) as unknown as MatchApi;
  }

  protected async onTimer(kind: string, id: string) {
    if (kind === "dispatch") await this.dispatch(id);
    else if (kind === "offer") await this.onOfferTimeout(id);
    else if (kind === "search") await this.onSearchTimeout(id);
    else if (kind === "sync") await this.push(id, "recover");
    else if (kind === "settle") await this.settleFromTimer(id);
    else if (kind === "create") await this.recoverCreate(id);
    else if (kind === "watch") await this.watchDriver(id);
    else if (kind === "track") await this.flushTrack(id);
    else if (kind === "handover") await this.handOver(id);
    else if (kind === "purge") this.purge();
  }

  private purge() {
    const now = Date.now();
    this.sql.exec(
      // keep a ride while Postgres still owes it a write, a settlement or route points
      `DELETE FROM rides WHERE status IN ('COMPLETED','CANCELLED','NO_DRIVER') AND updated_at < ?
         AND json_extract(data, '$.pending') IS NULL
         AND NOT (status = 'COMPLETED' AND json_extract(data, '$.paidAt') IS NULL)
         AND NOT EXISTS (SELECT 1 FROM track WHERE track.ride_id = rides.id)`,
      now - KEEP_TERMINAL_MS,
    );
    this.sql.exec(
      "DELETE FROM ride_idem WHERE ride_id NOT IN (SELECT id FROM rides)",
    );
    // drivers stay here only while on one of this actor's active rides
    this.sql.exec(
      "DELETE FROM drivers WHERE ride_id IS NULL OR ride_id NOT IN (SELECT id FROM rides WHERE status IN ('ACCEPTED','ARRIVED','ON_TRIP'))",
    );
    this.heads.clear(); // rides were deleted: refilled on the next ping
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rides").one().n;
    if (left > 0) void this.schedule("purge:all", now + PURGE_EVERY_MS);
  }

  // ------------------------------------------------------------ hot store: rides

  private loadRide(id: string): HotRide | null {
    const r = this.sql.exec<{ data: string }>("SELECT data FROM rides WHERE id = ?", id).toArray()[0];
    return r ? (JSON.parse(r.data) as HotRide) : null;
  }

  private saveRide(r: HotRide) {
    this.sql.exec(
      "INSERT OR REPLACE INTO rides (id, status, customer_id, driver_id, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      r.id, r.status, r.customerId, r.driverId, JSON.stringify(r), Date.now(),
    );
    this.heads.set(r.id, headOf(r));
  }

  private rideHead(id: string): RideHead | null {
    let h = this.heads.get(id);
    if (!h) {
      const r = this.loadRide(id);
      if (!r) return null;
      this.heads.set(id, (h = headOf(r)));
    }
    return h;
  }

  private view(r: HotRide): RideView {
    const {
      idempotencyKey: _k, queue: _q, rejected: _r, offer: _o, searchDeadline: _d,
      pgPending: _p, settleAttempts: _a, pending: _t, pgVersion: _v, driverLostAt: _l, dropoutDrivers: _x, handover: _h, ...v
    } = r;
    return v;
  }

  // ------------------------------------------------------------ ride transitions: Postgres first

  /**
   * Postgres is the source of truth for a ride's status. A transition is checked against the state
   * machine here, recorded as `pending` with a `sync:` timer (write-ahead: before Postgres is asked),
   * written to Postgres as a compare-and-set on the row's version, and only then applied here,
   * followed by its side effects.
   *  - Postgres refuses (driver busy, row moved on) → this actor follows Postgres, the caller gets an error.
   *  - Postgres unreachable / reply lost → UNAVAILABLE and the status here is unchanged. The `sync:`
   *    timer (or the next action on the ride) fences the row: either the write had committed and is
   *    applied here now, or it is guaranteed never to commit. "Refused" always means "did not happen".
   * A ride has at most one pending transition; actions on a ride run one at a time (see `serial`).
   */
  private async commit(
    rideId: string,
    ev: RideEvent,
    patch: (next: HotRide) => void,
    ctx: CommitCtx = {},
  ): Promise<Result<{ ride: HotRide; changed: boolean }>> {
    const ride = this.loadRide(rideId);
    if (!ride) return fail("RIDE_NOT_FOUND");
    if (ride.pending) return fail("UNAVAILABLE", "ride is being updated, retry");
    let to: RideStatus;
    try {
      const t = applyRideEvent(ride.status, ev);
      if (!t.changed) return { ok: true, ride, changed: false }; // duplicate: idempotent no-op
      to = t.status;
    } catch (e) {
      if (e instanceof DomainError) return fail(e.code, e.message);
      throw e;
    }
    const next: HotRide = { ...ride, status: to };
    patch(next);
    ride.pending = { id: crypto.randomUUID(), event: ev.type, next: this.view(next), base: ride.pgVersion ?? 0, attempts: 0 };
    this.saveRide(ride);
    await this.schedule(`sync:${rideId}`, Date.now() + CREATE_RECOVERY_MS);
    return this.push(rideId, "send", ctx);
  }

  /**
   * Resolve the ride's pending transition: "send" writes it (first attempt), "recover" fences it (its
   * earlier attempt failed or this actor restarted, so whether it committed is unknown). Concurrent
   * calls for one ride share a single attempt.
   */
  private push(rideId: string, mode: "send" | "recover", ctx: CommitCtx = {}): Promise<Result<{ ride: HotRide; changed: boolean }>> {
    const inflight = this.committing.get(rideId);
    if (inflight) return inflight;
    const run = this.pushOnce(rideId, mode, ctx).finally(() => this.committing.delete(rideId));
    this.committing.set(rideId, run);
    return run;
  }

  private async pushOnce(rideId: string, mode: "send" | "recover", ctx: CommitCtx): Promise<Result<{ ride: HotRide; changed: boolean }>> {
    const ride = this.loadRide(rideId);
    if (!ride) return fail("RIDE_NOT_FOUND");
    const p = ride.pending;
    if (!p) return { ok: true, ride, changed: false };
    let res: db.TransitionResult | "FENCED";
    try {
      if (mode === "send") {
        const settle = p.event === "COMPLETE" ? this.settleArgs(p.next) : null;
        res = await this.pg((sql) => db.transitionRide(sql, p.next, p.base, settle));
      } else {
        const f = await this.pg((sql) => db.fenceRide(sql, rideId, p.base));
        res = f.fenced ? "FENCED" : { ok: false, reason: "STALE", current: f.current, version: f.version };
      }
    } catch (e) {
      // outcome unknown: keep it pending; the `sync:` timer fences it later
      const cur = this.loadRide(rideId);
      if (cur?.pending?.id === p.id) {
        const attempts = ++cur.pending.attempts;
        console.error("ride transition: postgres failed", rideId, p.event, mode, `attempt ${attempts}`, e);
        this.saveRide(cur);
        await this.schedule(`sync:${rideId}`, Date.now() + retryDelay(attempts));
      }
      return fail("UNAVAILABLE", "database unavailable, retry");
    }
    return this.conclude(rideId, p, res, ctx);
  }

  /** Postgres answered for pending transition `p`: apply what it has, and drop the pending mark. */
  private async conclude(
    rideId: string,
    p: PendingTransition,
    res: db.TransitionResult | "FENCED",
    ctx: CommitCtx,
  ): Promise<Result<{ ride: HotRide; changed: boolean }>> {
    const ride = this.loadRide(rideId);
    if (!ride) return fail("RIDE_NOT_FOUND");
    if (ride.pending?.id !== p.id) {
      // concluded meanwhile by another path: report how it ended
      return ride.status === p.next.status ? { ok: true, ride, changed: true } : fail("INVALID_TRANSITION", `ride is ${ride.status}`);
    }
    ride.pending = undefined;
    this.cancelTimer(`sync:${rideId}`);

    if (res !== "FENCED" && res.ok) {
      ride.pgVersion = p.base + 1;
      return { ok: true, ride: await this.adopt(ride, p.next, p.event, res.settled, ctx), changed: true };
    }
    if (res !== "FENCED" && res.reason === "STALE" && res.current) {
      ride.pgVersion = res.version;
      const ours = res.version === p.base + 1 && res.current.status === p.next.status && res.current.driverId === p.next.driverId;
      if (ours) return { ok: true, ride: await this.adopt(ride, p.next, p.event, null, ctx), changed: true };
      // Postgres moved on without this actor knowing: it is the truth, follow it
      const event = EVENT_FOR[res.current.status];
      // OFFERING is this actor's own detail of REQUESTED: only a ride that had a driver went back to the search
      const moved = res.current.status === "REQUESTED" ? !ACTIVE_DISPATCH.has(ride.status) : res.current.status !== ride.status;
      if (moved && event) {
        console.error("ride: following postgres", rideId, ride.status, "→", res.current.status);
        const adopted = await this.adopt(ride, res.current, event, null, {});
        return fail("INVALID_TRANSITION", `ride is ${adopted.status}`);
      }
    }
    // not applied (fenced, refused, or only the version was behind): nothing changes here
    if (res === "FENCED") ride.pgVersion = p.base + 1;
    this.saveRide(ride);
    await this.resumeDispatch(ride);
    if (res !== "FENCED" && res.reason === "DRIVER_BUSY") return fail("DRIVER_BUSY", "driver already has an active ride");
    return fail("UNAVAILABLE", "not applied, retry");
  }

  /** Take Postgres' state of the ride (`src`) into this actor, then run the event's side effects. */
  private async adopt(
    ride: HotRide,
    src: RideView,
    event: RideEvent["type"],
    settled: db.SettleResult | null,
    ctx: CommitCtx,
  ): Promise<HotRide> {
    const before = ride.driverId; // REQUEUE: the driver who dropped the ride (Postgres no longer has it)
    const fields = ride as unknown as Record<string, unknown>;
    for (const k of PG_FIELDS) fields[k] = src[k];
    const offer = ride.offer;
    if (event !== "ARRIVE" && event !== "START" && event !== "COMPLETE") {
      ride.offer = null;
      ride.queue = [];
      for (const k of ["offer", "search", "dispatch"]) this.cancelTimer(`${k}:${ride.id}`);
    }
    if (event === "COMPLETE" || event === "CANCEL") ride.driverLostAt = undefined;
    if (event === "REQUEUE" && before) {
      // a fresh search that never offers this ride to the driver who dropped it
      ride.rejected.push(before);
      ride.dropoutDrivers = [...(ride.dropoutDrivers ?? []), before];
      ride.searchDeadline = Date.now() + this.cfg.searchTimeoutMs;
    }
    // the driver who accepted is registered in a match actor: it must learn they are on this ride now,
    // also when the accept's reply was lost or it only committed on the recovery path (A6)
    const handover = event === "ACCEPT" && offer && offer.driverId === ride.driverId;
    if (handover) ride.handover = { zone: offer.zone, driverId: offer.driverId, attempts: 0 };
    this.saveRide(ride);
    // same storage step as the save above: a pending handover always has its timer
    if (handover) await this.schedule(`handover:${ride.id}`, Date.now() + HANDOVER_DELAY_MS);
    // same storage step as the save above: a ride back in the search always has its timers
    if (event === "REQUEUE") {
      await this.schedule(`search:${ride.id}`, ride.searchDeadline);
      await this.schedule(`dispatch:${ride.id}`, Date.now());
    }
    // same storage step as the save above: an unsettled completion always has its retry timer
    if (event === "COMPLETE" && !settled) await this.schedule(`settle:${ride.id}`, Date.now() + retryDelay(1));
    if (event === "START") await this.schedule(`watch:${ride.id}`, Date.now() + this.cfg.driverLostAskMs);
    if (event === "START") await this.schedule(`track:${ride.id}`, Date.now() + this.cfg.trackFlushMs);
    if (event === "COMPLETE" || event === "CANCEL") this.cancelTimer(`watch:${ride.id}`);
    // the trip is over: keep its last position, send the rest of its route now (no-op for a ride cancelled before the trip)
    if (event === "COMPLETE" || event === "CANCEL") {
      this.keepTrack(ride.id, endTrack(this.tracks.get(ride.id)));
      this.tracks.delete(ride.id);
      await this.schedule(`track:${ride.id}`, Date.now());
    }

    if (event === "ACCEPT" && ride.driverId) {
      // The driver now lives in this ride actor for the whole trip.
      const d = this.loadDriver(ride.driverId) ?? {
        id: ride.driverId, name: ride.driver?.name ?? "", vehicle: ride.driver?.vehicle ?? null,
        lat: ctx.driverPos?.lat ?? null, lng: ctx.driverPos?.lng ?? null, heading: ctx.driverPos?.heading ?? null,
        status: "ON_RIDE" as DriverStatus, rideId: ride.id, reservedUntil: null, offer: null, updatedAt: Date.now(),
      };
      d.status = "ON_RIDE";
      d.rideId = ride.id;
      d.reservedUntil = null;
      d.offer = null;
      this.saveDriver(d);
    }
    const freedId = event === "CANCEL" ? ride.driverId : event === "REQUEUE" ? before : null;

    if (event === "REQUEUE") this.send(ride.customerId, { t: "ride.requeued", rideId: ride.id, reason: "DRIVER_CANCELLED" });
    this.notifyRide(ride);
    if (offer && offer.driverId !== ride.driverId)
      await this.stub(offer.zone).release(offer.driverId, ride.id, event === "NO_CANDIDATE" ? "NO_DRIVER" : "CANCELLED");
    if (freedId) await this.releaseDriver(freedId, ride.id, "AVAILABLE");
    if (event === "COMPLETE") await this.completeRide(ride, settled);
    return this.loadRide(ride.id) ?? ride;
  }

  /** A search that was paused for a transition that did not happen goes on. */
  private async resumeDispatch(ride: HotRide) {
    if (ACTIVE_DISPATCH.has(ride.status) && (!ride.offer || ride.offer.reserving) && !ride.pgPending) await this.schedule(`dispatch:${ride.id}`, Date.now());
  }

  /**
   * Run `fn` after every earlier status-changing action of this ride. Needed because a transition now
   * waits on Postgres: without it, "arrive, start, complete" sent back to back would interleave.
   * `fn` must not wait on another action of the same ride (it would wait on itself).
   */
  private serial<T>(rideId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(rideId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.lanes.set(rideId, tail);
    void tail.then(() => {
      if (this.lanes.get(rideId) === tail) this.lanes.delete(rideId);
    });
    return run;
  }

  /**
   * The ride, with a transition still on its way to Postgres concluded first — so transitions of one
   * ride happen one at a time, each from the state the previous one left.
   */
  private async ready(rideId: string): Promise<Result<{ ride: HotRide }>> {
    if (this.loadRide(rideId)?.pending) await this.push(rideId, "recover");
    const ride = this.loadRide(rideId);
    if (!ride) return fail("RIDE_NOT_FOUND");
    if (ride.pending) return fail("UNAVAILABLE", "database unavailable, retry");
    return { ok: true, ride };
  }

  private settleArgs(r: RideView): db.SettleArgs {
    return {
      rideId: r.id, customerId: r.customerId, driverId: r.driverId!, fare: r.fareFinal ?? r.fare,
      paymentMethod: r.paymentMethod, commissionRate: this.cfg.commissionRate,
    };
  }

  private notifyRide(r: HotRide) {
    const msg: ServerMsg = { t: "ride.status", rideId: r.id, status: r.status, driver: r.driver, at: Date.now(), ride: this.view(r) };
    this.send(r.customerId, msg);
    if (r.driverId) this.send(r.driverId, msg);
  }

  /** Apply a state-machine event; returns false when it was a duplicate (no-op). */
  private transition(r: HotRide, ev: RideEvent): boolean {
    const t = applyRideEvent(r.status, ev);
    r.status = t.status;
    return t.changed;
  }

  /** `handover:` timer: tell the accepting driver's zone, retried until it has heard. */
  private async handOver(rideId: string): Promise<void> {
    const ride = this.loadRide(rideId);
    const h = ride?.handover;
    if (!ride || !h) return;
    const home = homeOfRide(rideId)!;
    const onIt = ride.driverId === h.driverId && ["ACCEPTED", "ARRIVED", "ON_TRIP"].includes(ride.status);
    try {
      if (onIt) await this.stub(h.zone).handOverToRide(h.driverId, rideId, home);
      // the ride moved on before its driver was told (cancelled, requeued): only free their reservation
      else await this.stub(h.zone).release(h.driverId, rideId, "CANCELLED");
    } catch (e) {
      const cur = this.loadRide(rideId);
      if (!cur?.handover) return;
      const attempts = ++cur.handover.attempts;
      console.error("handover failed", rideId, h.zone, `attempt ${attempts}`, e);
      this.saveRide(cur);
      return void (await this.schedule(`handover:${rideId}`, Date.now() + retryDelay(attempts)));
    }
    const cur = this.loadRide(rideId);
    if (cur?.handover) {
      cur.handover = undefined;
      this.saveRide(cur);
    }
  }

  // ============================================================ RPC: ride lifecycle (ride's zone)

  async createRide(home: string, input: CreateRideInput): Promise<Result<{ ride: RideView }>> {
    this.learnZone(home);
    if (input.idempotencyKey) {
      const prev = this.sql
        .exec<{ ride_id: string }>("SELECT ride_id FROM ride_idem WHERE customer_id = ? AND key = ?", input.customerId, input.idempotencyKey)
        .toArray()[0];
      if (prev && this.loadRide(prev.ride_id)?.pgPending) await this.recoverCreate(prev.ride_id); // settle it first
      const r = prev && this.loadRide(prev.ride_id);
      if (r) return { ok: true, ride: this.view(r) };
    }
    const now = Date.now();
    const est = estimate(input.pickup, input.dropoff, this.cfg.fare);
    const ride: HotRide = {
      id: `${home}_${crypto.randomUUID().replaceAll("-", "")}`,
      status: "REQUESTED",
      customerId: input.customerId,
      driverId: null,
      driver: null,
      pickup: input.pickup,
      dropoff: input.dropoff,
      distanceM: est.distanceM,
      fare: est.fare,
      fareFinal: null,
      paymentMethod: input.paymentMethod,
      paidVia: null,
      paidAt: null,
      cancelReason: null,
      cancelledBy: null,
      rating: null,
      requestedAt: now,
      acceptedAt: null,
      arrivedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      idempotencyKey: input.idempotencyKey,
      queue: [],
      rejected: [],
      offer: null,
      searchDeadline: now + this.cfg.searchTimeoutMs,
      pgPending: true,
    };
    // Write-ahead: the ride is recorded here (pending) with a recovery timer BEFORE Postgres is asked.
    // If this actor dies while / after Postgres commits, recoverCreate finds out which way it went,
    // so a ride (and its wallet hold) can never exist in Postgres with no actor running it.
    this.saveRide(ride);
    if (input.idempotencyKey)
      this.sql.exec("INSERT OR REPLACE INTO ride_idem (customer_id, key, ride_id) VALUES (?, ?, ?)", input.customerId, input.idempotencyKey, ride.id);
    await this.schedule(`create:${ride.id}`, now + CREATE_RECOVERY_MS);

    // Postgres enforces one active ride per customer across all zones and idempotency,
    // and places the wallet hold. Only a ride the database accepted gets dispatched.
    let res: db.CreateRideResult;
    this.creating.add(ride.id);
    try {
      res = await this.pg((sql) => db.createRide(sql, this.view(ride), input.idempotencyKey));
    } catch (e) {
      // outcome unknown: the ride stays pending and the `create:` timer finds out which way it went
      console.error("create ride: postgres failed", ride.id, e);
      return fail("UNAVAILABLE", "database unavailable, retry with the same Idempotency-Key");
    } finally {
      this.creating.delete(ride.id);
    }
    if (!res.ok || res.existing) {
      this.dropRide(ride.id);
      if (!res.ok) return fail(res.code, res.message);
      const hot = this.loadRide(res.ride.id);
      return { ok: true, ride: hot ? this.view(hot) : res.ride };
    }
    await this.activate(ride);
    return { ok: true, ride: this.view(ride) };
  }

  /** Postgres has the ride: start dispatching it. */
  private async activate(ride: HotRide) {
    const now = Date.now();
    ride.pgPending = false;
    this.saveRide(ride);
    this.cancelTimer(`create:${ride.id}`);
    await this.schedule(`search:${ride.id}`, ride.searchDeadline);
    await this.schedule(`dispatch:${ride.id}`, now); // matching runs from the alarm, off the request path
    await this.schedule("purge:all", now + PURGE_EVERY_MS);
  }

  /** Forget a ride that never made it into Postgres. */
  private dropRide(rideId: string) {
    this.sql.exec("DELETE FROM rides WHERE id = ?", rideId);
    this.heads.delete(rideId);
    this.sql.exec("DELETE FROM ride_idem WHERE ride_id = ?", rideId);
    this.cancelTimer(`create:${rideId}`);
  }

  /**
   * A ride is still pending (the insert threw, or this actor restarted mid-insert): ask Postgres.
   * Committed → dispatch it; absent → drop it; Postgres unreachable → ask again later.
   */
  private async recoverCreate(rideId: string) {
    const ride = this.loadRide(rideId);
    if (!ride?.pgPending) return;
    if (this.creating.has(rideId)) return void (await this.schedule(`create:${rideId}`, Date.now() + CREATE_RECOVERY_MS));
    let committed: boolean;
    try {
      committed = (await this.pg((sql) => db.getRide(sql, rideId))) !== null;
    } catch (e) {
      console.error("create recovery failed", rideId, e);
      return void (await this.schedule(`create:${rideId}`, Date.now() + CREATE_RECOVERY_MS));
    }
    const cur = this.loadRide(rideId);
    if (!cur?.pgPending) return;
    if (!committed) return this.dropRide(rideId);
    cur.searchDeadline = Math.max(cur.searchDeadline, Date.now() + this.cfg.searchTimeoutMs / 2);
    await this.activate(cur);
  }

  /**
   * Sequential offering: reserve the next candidate, offer, wait for accept / reject / timeout.
   *
   * Runs in the ride's lane, so a reject / accept / cancel arriving mid-step waits for the step instead
   * of being lost, and steps never overlap. While a ride is searching, something always runs this
   * again: the `dispatch:` timer is set before every step that can fail (an RPC to another zone, this
   * actor dying) and replaced by the `offer:` timer once an offer stands. Every step decides from the
   * stored ride alone, so running it again is always safe.
   */
  private dispatch(rideId: string): Promise<void> {
    return this.serial(rideId, () => this.dispatchStep(rideId));
  }

  private async dispatchStep(rideId: string): Promise<void> {
    for (;;) {
      let ride = this.loadRide(rideId);
      // a pending transition (cancel / no driver) pauses the search; resumeDispatch picks it up again
      if (!ride || ride.pgPending || ride.pending || !ACTIVE_DISPATCH.has(ride.status)) return;
      if (ride.offer && !ride.offer.reserving) return; // an offer stands: its `offer:` timer moves on
      if (Date.now() >= ride.searchDeadline) return this.endSearch(rideId);
      await this.schedule(`dispatch:${rideId}`, Date.now() + DISPATCH_RETRY_MS);

      let target = ride.offer; // a reservation whose outcome is unknown: retry the same driver
      if (target && (target.tries ?? 0) >= RESERVE_TRIES) {
        ride.offer = null;
        ride.rejected.push(target.driverId);
        this.saveRide(ride);
        await this.releaseQuietly(target.zone, target.driverId, rideId, "TIMEOUT");
        continue;
      }
      if (!target) {
        if (ride.queue.length === 0) {
          const found = await this.findCandidates(ride);
          ride = this.loadRide(rideId);
          if (!ride || ride.pending || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) return;
          if (found.length === 0) {
            // nobody free nearby right now: drivers come online, finish trips — look again shortly
            return void (await this.schedule(`dispatch:${rideId}`, Date.now() + this.cfg.researchDelayMs));
          }
          ride.queue = found;
        }
        const c = ride.queue.shift()!;
        target = { driverId: c.driverId, zone: c.zone, expiresAt: 0, reserving: true, tries: 0 };
      }
      const offer: OfferPayload = {
        rideId,
        pickup: ride.pickup,
        dropoff: ride.dropoff,
        fare: ride.fare,
        distanceM: ride.distanceM,
        paymentMethod: ride.paymentMethod,
        expiresAt: Date.now() + this.cfg.offerTimeoutMs,
      };
      // write-ahead: if the RPC below throws or this actor dies, the next step knows whom to retry
      ride.offer = { ...target, expiresAt: offer.expiresAt, reserving: true, tries: (target.tries ?? 0) + 1 };
      this.saveRide(ride);
      const reserved = await this.stub(target.zone).reserveAndOffer(target.driverId, offer, this.cfg.reserveTtlMs);

      ride = this.loadRide(rideId);
      if (!ride || ride.pending || !ACTIVE_DISPATCH.has(ride.status) || ride.offer?.driverId !== target.driverId) {
        // moved on while we were reserving
        if (reserved) await this.releaseQuietly(target.zone, target.driverId, rideId, "CANCELLED");
        return;
      }
      if (!reserved) {
        // busy / gone: next candidate
        ride.offer = null;
        this.saveRide(ride);
        continue;
      }

      const first = ride.status === "REQUESTED";
      this.transition(ride, { type: "OFFER" });
      ride.offer = { driverId: target.driverId, zone: target.zone, expiresAt: offer.expiresAt };
      this.saveRide(ride);
      await this.schedule(`offer:${rideId}`, offer.expiresAt);
      this.cancelTimer(`dispatch:${rideId}`);
      // OFFERING is this actor's own detail of searching: Postgres keeps the ride REQUESTED
      if (first) this.notifyRide(ride);
      return;
    }
  }

  /** Free a driver reserved for this ride; a failure only logs (the reservation expires on its own). */
  private async releaseQuietly(zone: string, driverId: string, rideId: string, reason: string) {
    try {
      await this.stub(zone).release(driverId, rideId, reason);
    } catch (e) {
      console.error("release failed", rideId, driverId, e);
    }
  }

  /**
   * Rings of geohash cells (fine → coarse), each fanned out to the zones that own them. A zone that
   * fails is skipped; only when every zone of a ring fails does the search fail (and is retried).
   */
  private async findCandidates(ride: HotRide): Promise<(Candidate & { zone: string })[]> {
    const exclude = ride.rejected;
    for (const precision of this.cfg.match.ringPrecisions) {
      const cells = searchCells(ride.pickup, precision);
      const byZone = new Map<string, string[]>();
      for (const cell of cells) {
        const z = cell.slice(0, this.cfg.zonePrecision);
        byZone.set(z, [...(byZone.get(z) ?? []), cell]);
      }
      const results = await Promise.allSettled(
        [...byZone].map(async ([zone, zcells]) =>
          (await this.stub(zone).nearest(zcells, ride.pickup, exclude)).map((c) => ({ ...c, zone })),
        ),
      );
      const lists: (Candidate & { zone: string })[][] = [];
      for (const r of results) {
        if (r.status === "fulfilled") lists.push(r.value);
        else console.error("search: zone failed", ride.id, r.reason);
      }
      if (lists.length === 0) throw new Error("search: every zone failed");
      const merged = lists.flat().sort((a, b) => a.distanceM - b.distanceM).slice(0, this.cfg.match.k);
      if (merged.length) return merged;
    }
    return [];
  }

  /** Search is over without a driver. If Postgres can't record it now, the `sync:` timer will. */
  private noDriver(rideId: string): Promise<void> {
    return this.serial(rideId, () => this.endSearch(rideId));
  }

  /** `noDriver` from inside the ride's lane. */
  private async endSearch(rideId: string): Promise<void> {
    const ride = this.loadRide(rideId);
    if (!ride || ride.pending || !ACTIVE_DISPATCH.has(ride.status)) return;
    const res = await this.commit(rideId, { type: "NO_CANDIDATE" }, () => {});
    if (!res.ok) console.error("no driver: not recorded yet", rideId, res.code);
  }

  private onOfferTimeout(rideId: string): Promise<void> {
    return this.serial(rideId, async () => {
      const ride = this.loadRide(rideId);
      if (!ride?.offer || ride.offer.reserving || ride.status !== "OFFERING") return;
      // an accept / cancel is on its way to Postgres: let it conclude first
      if (ride.pending) return void (await this.schedule(`offer:${rideId}`, Date.now() + CREATE_RECOVERY_MS));
      if (Date.now() < ride.offer.expiresAt) return void (await this.schedule(`offer:${rideId}`, ride.offer.expiresAt));
      const o = ride.offer;
      await this.dropOffer(ride, o.driverId); // arms `dispatch:` before anything that can fail
      await this.releaseQuietly(o.zone, o.driverId, rideId, "TIMEOUT");
    });
  }

  private async onSearchTimeout(rideId: string) {
    await this.noDriver(rideId);
  }

  async offerRejected(rideId: string, driverId: string): Promise<void> {
    this.learnZone(homeOfRide(rideId));
    // in the lane: a reject that races the offer's reservation waits for it instead of being dropped
    await this.serial(rideId, async () => {
      const ride = this.loadRide(rideId);
      if (!ride || ride.offer?.driverId !== driverId || ride.pending?.event === "ACCEPT") return;
      await this.dropOffer(ride, driverId);
    });
  }

  /** The offered driver is out (rejected, busy elsewhere): never offer them this ride again. */
  private async dropOffer(ride: HotRide, driverId: string) {
    ride.offer = null;
    ride.rejected.push(driverId);
    this.saveRide(ride);
    this.cancelTimer(`offer:${ride.id}`);
    // the search goes on from the alarm: off the caller's path, and it survives this actor dying
    await this.schedule(`dispatch:${ride.id}`, Date.now());
  }

  async acceptOffer(
    rideId: string,
    driver: DriverInfo & { lat: number | null; lng: number | null; heading: number | null },
  ): Promise<Result<{ ride: RideView }>> {
    this.learnZone(homeOfRide(rideId));
    return this.serial(rideId, async (): Promise<Result<{ ride: RideView }>> => {
      const r = await this.ready(rideId);
      if (!r.ok) return r;
      const ride = r.ride;
      if (ride.driverId === driver.id && ride.status === "ACCEPTED") return { ok: true, ride: this.view(ride) };
      if (ride.status !== "OFFERING" || ride.offer?.driverId !== driver.id || Date.now() > ride.offer.expiresAt)
        return fail("OFFER_EXPIRED");
      const c = await this.commit(
        rideId,
        { type: "ACCEPT" },
        (n) => {
          n.driverId = driver.id;
          n.driver = { id: driver.id, name: driver.name, vehicle: driver.vehicle };
          n.acceptedAt = Date.now();
        },
        { driverPos: { lat: driver.lat, lng: driver.lng, heading: driver.heading } },
      );
      if (!c.ok) {
        const cur = this.loadRide(rideId);
        if (c.code === "DRIVER_BUSY" && cur?.offer?.driverId === driver.id) {
          // the driver holds an active ride in another zone (Postgres says so): next candidate
          await this.dropOffer(cur, driver.id);
        }
        return c;
      }
      return { ok: true, ride: this.view(c.ride) };
    });
  }

  async cancelRide(rideId: string, userId: string, role: Role, reason: string): Promise<Result<{ ride: RideView }>> {
    this.learnZone(homeOfRide(rideId));
    return this.serial(rideId, async () => {
      const r = await this.ready(rideId);
      if (!r.ok) return r;
      const ride = r.ride;
      if (role === "driver") return this.driverDrops(ride, userId);
      if (ride.customerId !== userId) return fail("FORBIDDEN");
      if (ride.pgPending) return fail("INVALID_TRANSITION", "ride is still being created, try again shortly");
      const res = await this.commit(rideId, { type: "CANCEL", by: role }, (n) => {
        n.cancelReason = reason || null;
        n.cancelledBy = role;
        n.cancelledAt = Date.now();
      });
      if (!res.ok) return res;
      return { ok: true, ride: this.view(res.ride) };
    });
  }

  /**
   * The driver drops the ride before the trip (in the ride's lane). The order stays: the ride goes back
   * to the search without this driver (REQUEUE), the customer keeps the wallet hold. A ride its drivers
   * dropped `maxRequeues` times is cancelled by the system instead, so a customer never waits forever.
   */
  private async driverDrops(ride: HotRide, driverId: string): Promise<Result<{ ride: RideView }>> {
    // a retry of a drop that went through (its reply was lost): same answer
    if (ride.dropoutDrivers?.includes(driverId)) return { ok: true, ride: this.view(ride) };
    if (ride.driverId !== driverId) return fail("FORBIDDEN");
    const res =
      (ride.dropoutDrivers?.length ?? 0) >= this.cfg.maxRequeues
        ? await this.commit(ride.id, { type: "CANCEL", by: "system" }, (n) => {
            n.cancelReason = "drivers_cancelled";
            n.cancelledBy = "system";
            n.cancelledAt = Date.now();
          })
        : await this.commit(ride.id, { type: "REQUEUE" }, (n) => {
            n.driverId = null;
            n.driver = null;
            n.acceptedAt = null;
            n.arrivedAt = null;
          });
    if (!res.ok) return res;
    return { ok: true, ride: this.view(res.ride) };
  }

  // ------------------------------------------------------------ trip route

  /**
   * `track:` timer: send the trip's buffered route points to Postgres, oldest first, then delete what
   * was sent. Runs every `trackFlushMs` while the ride is ON_TRIP and once more when it ends; points
   * that could not be sent (Postgres down) stay buffered and go with the next run. Repeating a batch
   * whose reply was lost is harmless (`seq` is the key in Postgres).
   */
  private async flushTrack(rideId: string) {
    const points = this.sql
      .exec<db.TrackPoint>("SELECT seq, lat, lng, at FROM track WHERE ride_id = ? ORDER BY seq LIMIT ?", rideId, TRACK_BATCH)
      .toArray();
    let sentFull = false;
    if (points.length) {
      try {
        await this.pg((sql) => db.insertTrack(sql, rideId, points));
        this.sql.exec("DELETE FROM track WHERE ride_id = ? AND seq <= ?", rideId, points[points.length - 1]!.seq);
        sentFull = points.length === TRACK_BATCH;
      } catch (err) {
        console.error("track flush failed", rideId, err);
      }
    }
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM track WHERE ride_id = ?", rideId).one().n;
    const onTrip = this.loadRide(rideId)?.status === "ON_TRIP";
    // a full batch went through and more is waiting (a long backlog): go on right away
    if (sentFull && left > 0) await this.schedule(`track:${rideId}`, Date.now());
    else if (onTrip || left > 0) await this.schedule(`track:${rideId}`, Date.now() + this.cfg.trackFlushMs);
  }

  // ------------------------------------------------------------ driver gone silent mid-trip

  /** Last sign of life of the trip's driver: their latest location ping (or the trip's start). */
  private driverSeenAt(ride: HotRide): number {
    const ping = ride.driverId ? (this.pos.get(ride.driverId)?.ts ?? 0) : 0;
    return Math.max(ride.startedAt ?? 0, ping);
  }

  /**
   * `watch:` timer of an ON_TRIP ride. A driver whose phone died leaves the trip open, which locks the
   * customer (one active ride) and their wallet hold. Silent for `driverLostAskMs` → ask the customer
   * (they are in the car, they know) and ask again every interval; silent for `driverLostCancelMs` →
   * the system cancels the ride (hold released). Pings are not written anywhere: this reads memory.
   */
  private watchDriver(rideId: string): Promise<void> {
    return this.serial(rideId, async () => {
      const ride = this.loadRide(rideId);
      if (!ride || ride.status !== "ON_TRIP" || !ride.driverId) return;
      const now = Date.now();
      const { driverLostAskMs: ask, driverLostCancelMs: cancelAfter } = this.cfg;
      if (ride.pending) return this.schedule(`watch:${rideId}`, now + retryDelay(1)); // a transition is settling first
      const seen = this.driverSeenAt(ride);
      if (now - seen < ask) {
        this.driverBack(ride);
        return this.schedule(`watch:${rideId}`, seen + ask);
      }
      if (now - seen >= cancelAfter) {
        const res = await this.commit(rideId, { type: "CANCEL", by: "system" }, (n) => {
          n.cancelReason = "driver_lost";
          n.cancelledBy = "system";
          n.cancelledAt = Date.now();
        });
        if (!res.ok && this.loadRide(rideId)?.status === "ON_TRIP") await this.schedule(`watch:${rideId}`, Date.now() + retryDelay(1));
        return;
      }
      ride.driverLostAt ??= now;
      this.saveRide(ride);
      this.send(ride.customerId, { t: "ride.driver_lost", rideId, lastSeenAt: seen, autoCancelAt: seen + cancelAfter });
      await this.schedule(`watch:${rideId}`, Math.min(now + ask, seen + cancelAfter));
    });
  }

  /** The driver of a trip the customer was asked about is back: withdraw the question. */
  private driverBack(ride: HotRide) {
    if (!ride.driverLostAt) return;
    ride.driverLostAt = undefined;
    this.saveRide(ride);
    this.send(ride.customerId, { t: "ride.driver_back", rideId: ride.id });
  }

  /** The customer answers "driver gone silent": the trip ended fine (complete + pay) or it did not (cancel). */
  async driverLost(rideId: string, customerId: string, action: DriverLostAction): Promise<Result<{ ride: RideView }>> {
    this.learnZone(homeOfRide(rideId));
    return this.serial(rideId, async () => {
      const r = await this.ready(rideId);
      if (!r.ok) return r;
      const ride = r.ride;
      if (ride.customerId !== customerId) return fail("FORBIDDEN");
      if (ride.status !== "ON_TRIP" || !ride.driverLostAt || Date.now() - this.driverSeenAt(ride) < this.cfg.driverLostAskMs)
        return fail("INVALID_TRANSITION", "the driver is not reported lost");
      const res =
        action === "arrived"
          ? await this.commit(rideId, { type: "COMPLETE" }, (n) => {
              n.completedAt = Date.now();
              n.fareFinal = n.fare;
            })
          : await this.commit(rideId, { type: "CANCEL", by: "system" }, (n) => {
              n.cancelReason = "driver_lost_reported";
              n.cancelledBy = "system";
              n.cancelledAt = Date.now();
            });
      if (!res.ok) return res;
      return { ok: true, ride: this.view(res.ride) };
    });
  }

  private rideEventByDriver(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<void> {
    return this.serial(rideId, () => this.driverRideEventNow(driverId, rideId, type));
  }

  private async driverRideEventNow(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<void> {
    const r = await this.ready(rideId);
    if (!r.ok) throw new DomainError(r.code, r.message);
    if (r.ride.driverId !== driverId) throw new DomainError("FORBIDDEN");
    // only the step that changes the status: a repeated "complete" stays an idempotent no-op wherever the driver is
    if (type === "ARRIVE" && r.ride.status === "ACCEPTED") this.requireAt(driverId, r.ride.pickup, this.cfg.atPlace.arriveM, "pickup");
    if (type === "COMPLETE" && r.ride.status === "ON_TRIP") this.requireAt(driverId, r.ride.dropoff, this.cfg.atPlace.completeM, "dropoff");
    const res = await this.commit(rideId, { type }, (n) => {
      const now = Date.now();
      if (type === "ARRIVE") n.arrivedAt = now;
      if (type === "START") n.startedAt = now;
      if (type === "COMPLETE") {
        n.completedAt = now;
        n.fareFinal = n.fare; // fixed upfront price
      }
    });
    if (!res.ok) throw new DomainError(res.code, res.message);
    // duplicate "complete": idempotent no-op — except it re-drives an unfinished settlement
    if (!res.changed && type === "COMPLETE" && res.ride.paidAt === null) await this.settleFromTimer(rideId);
  }

  /**
   * The driver's last known position (live ping, else the ≤ 30 s old snapshot) must be within `maxM` of
   * `place`: no "arrived" from across town, no paid trip from a driver who never moved. 0 = no check.
   */
  private requireAt(driverId: string, place: Place, maxM: number, what: "pickup" | "dropoff") {
    if (maxM <= 0) return;
    const d = this.loadDriver(driverId);
    if (!d || d.lat === null || d.lng === null)
      throw new DomainError("TOO_FAR", `no recent location: send a loc, then try again at the ${what}`);
    const m = Math.round(haversineM({ lat: d.lat, lng: d.lng }, place));
    if (m > maxM) throw new DomainError("TOO_FAR", `${m} m from the ${what} (must be within ${maxM} m)`);
  }

  /**
   * The trip is over (settled in the same Postgres transaction when `settled` is given). Free the
   * driver whatever happens — a failed settlement must not keep the driver stuck ON_RIDE; the
   * `settle:` timer keeps retrying it.
   */
  private async completeRide(ride: HotRide, settled: db.SettleResult | null) {
    const driverId = ride.driverId!;
    const balance = settled ? this.applyPaid(ride.id, settled) : await this.settle(ride.id);
    const low = balance !== null && balance < this.cfg.driverMinBalance;
    if (low) this.send(driverId, { t: "error", code: "DRIVER_BALANCE_TOO_LOW", message: "top up before going online again" });
    await this.releaseDriver(driverId, ride.id, low ? "OFFLINE" : "AVAILABLE");
  }

  /**
   * Retry path (timer / repeated "complete"). The driver is back in a match actor by now: their
   * balance is checked again when they next go online.
   */
  private async settleFromTimer(rideId: string) {
    await this.settle(rideId);
  }

  /**
   * Settle a COMPLETED ride in Postgres (idempotent there). Returns the driver's balance on success,
   * null when there was nothing to do or it failed (then the `settle:` timer is re-armed with backoff).
   */
  private async settle(rideId: string): Promise<number | null> {
    const ride = this.loadRide(rideId);
    if (!ride || ride.status !== "COMPLETED" || ride.paidAt !== null || !ride.driverId) {
      this.cancelTimer(`settle:${rideId}`);
      return null;
    }
    const driverId = ride.driverId;
    const fare = ride.fareFinal ?? ride.fare;
    if (this.settling.has(rideId)) {
      await this.schedule(`settle:${rideId}`, Date.now() + retryDelay(1));
      return null;
    }
    this.settling.add(rideId);
    let res: db.SettleResult;
    try {
      res = await this.pg((sql) => db.settleRide(sql, {
        rideId, customerId: ride.customerId, driverId, fare,
        paymentMethod: ride.paymentMethod, commissionRate: this.cfg.commissionRate,
      }));
    } catch (e) {
      const cur = this.loadRide(rideId);
      if (!cur || cur.paidAt !== null) return null;
      cur.settleAttempts = (cur.settleAttempts ?? 0) + 1;
      console.error("settlement failed", rideId, `attempt ${cur.settleAttempts}`, e);
      this.saveRide(cur);
      await this.schedule(`settle:${rideId}`, Date.now() + retryDelay(cur.settleAttempts));
      return null;
    } finally {
      this.settling.delete(rideId);
    }
    return this.applyPaid(rideId, res);
  }

  /** Postgres settled the ride: record it here and tell both sides. Returns the driver's balance. */
  private applyPaid(rideId: string, res: db.SettleResult): number | null {
    const cur = this.loadRide(rideId);
    if (!cur || cur.paidAt !== null || !cur.driverId) return null; // a concurrent attempt already finished (and notified)
    const fare = cur.fareFinal ?? cur.fare;
    cur.paidVia = res.paidVia;
    cur.paidAt = Date.now();
    this.saveRide(cur);
    this.cancelTimer(`settle:${rideId}`);
    this.send(cur.customerId, { t: "ride.paid", rideId, paidVia: res.paidVia, fare, balance: res.customerBalance });
    this.send(cur.driverId, { t: "ride.paid", rideId, paidVia: res.paidVia, fare, balance: res.driverBalance });
    return res.driverBalance;
  }

  // ============================================================ drivers on a trip

  /**
   * The ride no longer needs its driver (completed, cancelled, dropped): hand them back to the match
   * actor of where they are now, then point their sockets there. If that call fails the driver
   * reconnects OFFLINE there and goes online again.
   */
  private async releaseDriver(driverId: string, rideId: string, status: "AVAILABLE" | "OFFLINE") {
    const d = this.loadDriver(driverId);
    if (!d || d.rideId !== rideId) return;
    const zone = d.lat !== null && d.lng !== null ? this.zoneOf(d.lat, d.lng) : this.zone!;
    this.removeDriver(driverId);
    this.send(driverId, { t: "driver.state", status, rideId: null });
    try {
      await this.stub(zone).returnDriver({ id: d.id, name: d.name, vehicle: d.vehicle, lat: d.lat, lng: d.lng, heading: d.heading }, status);
    } catch (e) {
      console.error("return driver failed", driverId, zone, e);
    }
    // not closed here: the client closes and reconnects (a ride event it sends meanwhile still lands)
    this.moveSockets(driverId, matchRoute(zone), false);
  }

  private keepTrack(rideId: string, points: TrackPt[]) {
    for (const p of points) this.sql.exec("INSERT INTO track (ride_id, lat, lng, at) VALUES (?, ?, ?, ?)", rideId, p.lat, p.lng, p.at);
  }

  /** A location ping of a driver on one of this actor's rides: the customer's map and the trip route. */
  private onDriverLoc(d: PingDriver, loc: { lat: number; lng: number; heading?: number }) {
    const now = this.takePing(d, loc);
    if (!now || d.status !== "ON_RIDE" || !d.rideId) return;
    const ride = this.rideHead(d.rideId);
    if (!ride) return;
    // the trip's route, thinned (straight stretches + turns): buffered here, sent to Postgres in batches by the `track:` timer
    if (ride.status === "ON_TRIP") {
      const { keep, state } = sampleTrack(this.tracks.get(ride.id) ?? null, { lat: d.lat!, lng: d.lng!, at: d.updatedAt }, this.cfg.track);
      this.tracks.set(ride.id, state);
      this.keepTrack(ride.id, keep);
    }
    this.send(ride.customerId, { t: "driver.loc", rideId: ride.id, lat: d.lat!, lng: d.lng!, heading: d.heading });
    if (ride.driverLostAt) {
      const full = this.loadRide(ride.id);
      if (full) this.driverBack(full);
    }
  }

  async driverRideEvent(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<Result> {
    try {
      await this.rideEventByDriver(driverId, rideId, type);
      return { ok: true };
    } catch (e) {
      if (e instanceof DomainError) return fail(e.code, e.message);
      throw e;
    }
  }

  async driverLoc(driverId: string, rideId: string, loc: { lat: number; lng: number; heading?: number }): Promise<void> {
    const d = this.loadDriverPing(driverId);
    if (d && d.rideId === rideId) this.onDriverLoc(d, loc);
  }

  async rideOf(rideId: string, userId: string): Promise<RideView | null> {
    const ride = this.loadRide(rideId);
    return ride && (ride.customerId === userId || ride.driverId === userId) ? this.view(ride) : null;
  }

  // ============================================================ WebSocket (hibernation API)

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const m = this.upgradeMeta(req);
    if (!m) return new Response("bad request", { status: 400 });
    this.learnZone(m.zone);
    const { client, server } = this.acceptSocket({ userId: m.userId, role: m.role, name: m.name });

    let driverStatus: DriverStatus | undefined;
    let rideId: string | null = null;
    if (m.role === "driver") {
      let d = this.loadDriver(m.userId);
      if (!d) {
        // a driver whose active ride lives here (reconnect, or the accept's hand-over)
        const active = this.sql
          .exec<{ id: string }>("SELECT id FROM rides WHERE driver_id = ? AND status IN ('ACCEPTED','ARRIVED','ON_TRIP')", m.userId)
          .toArray()[0];
        if (!active) {
          // not on a ride here (it ended meanwhile): free drivers live in the match actors
          const zone = m.lat !== null && m.lng !== null ? this.zoneOf(m.lat, m.lng) : (this.zone ?? zoneOfKey(m.zone));
          this.sendWs(server, { t: "reconnect", route: matchRoute(zone) });
          server.close(4001, "zone moved");
          return new Response(null, { status: 101, webSocket: client });
        }
        d = {
          id: m.userId, name: m.name, vehicle: null, lat: null, lng: null, heading: null,
          status: "ON_RIDE", rideId: active.id, reservedUntil: null, offer: null, updatedAt: Date.now(),
        };
      }
      if (m.lat !== null && m.lng !== null) {
        d.lat = m.lat;
        d.lng = m.lng;
        d.updatedAt = Date.now();
      }
      this.saveDriver(d);
      driverStatus = d.status;
      rideId = d.rideId;
    } else {
      rideId = this.sql
        .exec<{ id: string }>("SELECT id FROM rides WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1", m.userId)
        .toArray()[0]?.id ?? null;
    }
    this.sendWs(server, { t: "hello", route: rideRoute(m.zone), role: m.role, driverStatus, rideId });
    return new Response(null, { status: 101, webSocket: client });
  }

  protected async handle(ws: WebSocket, meta: SocketMeta, msg: ClientMsg) {
    if (msg.t === "resume") return this.resume(ws, meta, msg.rideId);
    if (meta.role !== "driver") throw new DomainError("FORBIDDEN", `${msg.t} is driver-only`);

    if ("rideId" in msg && msg.rideId && msg.t.startsWith("ride.")) {
      // another ride actor's ride: point the driver there
      const rz = homeOfRide(msg.rideId);
      if (rz && rz !== this.key) return this.sendWs(ws, { t: "reconnect", route: rideRoute(rz) });
      const type = msg.t === "ride.arrived" ? "ARRIVE" : msg.t === "ride.start" ? "START" : "COMPLETE";
      return this.rideEventByDriver(meta.userId, msg.rideId, type);
    }

    // the bulk of the traffic: only the columns a ping needs (the trip is over and the driver handed back: dropped)
    if (msg.t === "loc") {
      const p = this.loadDriverPing(meta.userId);
      if (p) this.onDriverLoc(p, msg);
      return;
    }

    const d = this.loadDriver(meta.userId);
    if (!d) {
      // the trip is over and the driver was handed back: redirect
      this.sendWs(ws, { t: "reconnect", route: null });
      return;
    }
    switch (msg.t) {
      case "online":
        return this.sendDriverState(d);
      case "offline":
        throw new DomainError("DRIVER_BUSY", "finish the ride first");
      case "offer.accept":
        if (d.rideId === msg.rideId) return this.resume(ws, meta, msg.rideId);
        throw new DomainError("OFFER_EXPIRED");
      case "offer.reject":
        return; // late / duplicate: the driver is on a ride
      default:
        throw new DomainError("BAD_REQUEST", `unknown message type ${(msg as { t: string }).t}`);
    }
  }

  private resume(ws: WebSocket, meta: SocketMeta, rideId?: string) {
    if (meta.role === "driver") {
      const d = this.loadDriver(meta.userId);
      if (d) {
        this.sendWs(ws, { t: "driver.state", status: d.status, rideId: d.rideId });
        if (d.status === "RESERVED" && d.offer && d.offer.expiresAt > Date.now()) this.sendWs(ws, { t: "offer", ...d.offer });
        rideId ??= d.status === "ON_RIDE" ? (d.rideId ?? undefined) : undefined;
      }
    }
    if (!rideId) return;
    const ride = this.loadRide(rideId);
    if (!ride) {
      const rz = homeOfRide(rideId);
      if (rz && rz !== this.key) return this.sendWs(ws, { t: "reconnect", route: rideRoute(rz) });
      return this.sendWs(ws, { t: "error", code: "RIDE_NOT_FOUND", message: rideId });
    }
    if (ride.customerId !== meta.userId && ride.driverId !== meta.userId) {
      return this.sendWs(ws, { t: "error", code: "FORBIDDEN", message: rideId });
    }
    this.sendWs(ws, { t: "ride.status", rideId, status: ride.status, driver: ride.driver, at: Date.now(), ride: this.view(ride) });
    if (ride.driverLostAt && ride.status === "ON_TRIP" && meta.userId === ride.customerId) {
      const seen = this.driverSeenAt(ride);
      this.sendWs(ws, { t: "ride.driver_lost", rideId, lastSeenAt: seen, autoCancelAt: seen + this.cfg.driverLostCancelMs });
    }
  }
}
