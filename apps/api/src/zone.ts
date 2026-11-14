import { DurableObject } from "cloudflare:workers";
import {
  acceptPing,
  applyRideEvent,
  type Candidate,
  DomainError,
  type DriverSnapshot,
  type DriverStatus,
  estimate,
  geohashChildren,
  geohashEncode,
  isValidLatLng,
  type PaymentMethod,
  type Place,
  rankCandidates,
  type RideEvent,
  type RideStatus,
  type Role,
  searchCells,
  shouldHandOff,
} from "@gojek/core";
import { type Config, loadConfig, zoneOfRide, zoneStub } from "./config";
import * as db from "./db";
import { type Sql, withDb } from "./pg";
import {
  type ClientMsg,
  type DriverInfo,
  fail,
  type OfferPayload,
  type Result,
  type RideView,
  type ServerMsg,
  type Vehicle,
} from "./protocol";

/** Hot ride state: the client view plus dispatch internals. */
interface HotRide extends RideView {
  idempotencyKey: string | null;
  queue: (Candidate & { zone: string })[];
  rejected: string[];
  offer: { driverId: string; zone: string; expiresAt: number } | null;
  searched: boolean;
  researched: boolean;
  searchDeadline: number;
  /** written to this actor, Postgres insert not confirmed yet (see createRide / recoverCreate) */
  pgPending?: boolean;
  /** a status change sent to Postgres whose outcome is not known yet (see commit / push) */
  pending?: PendingTransition;
  /** Postgres `rides.version` as of this actor's last write / read */
  pgVersion?: number;
  /** failed settlement attempts (retried by the `settle:` timer) */
  settleAttempts?: number;
}

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
  ACCEPTED: "ACCEPT", ARRIVED: "ARRIVE", ON_TRIP: "START", COMPLETED: "COMPLETE", CANCELLED: "CANCEL", NO_DRIVER: "NO_CANDIDATE",
};

interface DriverRow {
  id: string;
  name: string;
  vehicle: Vehicle | null;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  status: DriverStatus;
  rideId: string | null;
  reservedUntil: number | null;
  offer: OfferPayload | null;
  updatedAt: number;
}

/** Live driver position, kept in memory only (snapshotted to SQLite every SNAPSHOT_MS). */
interface Pos {
  lat: number;
  lng: number;
  heading: number | null;
  /** last accepted ping */
  ts: number;
  /** grid cell (geohash at the finest search precision) */
  cell: string;
  /** when the position was last written to SQLite */
  savedAt: number;
  /** consecutive pings outside this zone (hand-over hysteresis) */
  outside: number;
}

interface SocketMeta {
  userId: string;
  role: Role;
  name: string;
}

export interface CreateRideInput {
  customerId: string;
  pickup: Place;
  dropoff: Place;
  paymentMethod: PaymentMethod;
  idempotencyKey: string | null;
}

/** Methods other zones / the Worker call over RPC. Results never throw across the wire. */
export interface ZoneApi {
  createRide(zone: string, input: CreateRideInput): Promise<Result<{ ride: RideView }>>;
  cancelRide(rideId: string, userId: string, role: Role, reason: string): Promise<Result<{ ride: RideView }>>;
  nearest(cells: string[], pickup: Place, exclude: string[]): Promise<Candidate[]>;
  reserveAndOffer(driverId: string, offer: OfferPayload, ttlMs: number): Promise<boolean>;
  release(driverId: string, rideId: string, reason: string): Promise<void>;
  acceptOffer(rideId: string, driver: DriverInfo & { lat: number | null; lng: number | null; heading: number | null }): Promise<Result<{ ride: RideView }>>;
  offerRejected(rideId: string, driverId: string): Promise<void>;
  reset(): Promise<void>;
}

/** Searching statuses. OFFERING lives only in this actor; Postgres keeps such a ride REQUESTED. */
const ACTIVE_DISPATCH = new Set(["REQUESTED", "OFFERING"]);
const PURGE_EVERY_MS = 10 * 60_000;
const KEEP_TERMINAL_MS = 60 * 60_000;
const KEEP_IDLE_DRIVER_MS = 60 * 60_000;
const SNAPSHOT_MS = 30_000;
const ALARM_CONCURRENCY = 16;
/** a ride still pgPending (or with a pending transition) after this long is checked against Postgres */
const CREATE_RECOVERY_MS = 5_000;

/** Backoff for Postgres retries (pending transitions, settlement): 2 s, 4 s, … capped at 60 s. */
const retryDelay = (attempt: number) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));

/** Run `fn` over `items` with at most `limit` in flight. */
async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Zone actor: single writer for every driver and ride in one geohash zone.
 * Hot state lives in this DO's SQLite (survives hibernation); Postgres is written through for history.
 * Driver positions live in memory (+ a geohash grid for matching) and are only snapshotted to SQLite,
 * so a location ping costs no storage write.
 */
export class ZoneDO extends DurableObject<Env> implements ZoneApi {
  private cfg: Config;
  private sql: SqlStorage;
  private zone: string | null;
  private registered: boolean;
  private dispatching = new Set<string>();
  private pos = new Map<string, Pos>();
  private grid = new Map<string, Set<string>>();
  private gridPrecision: number;
  /** cached alarm time: undefined = unknown (read lazily), null = none set */
  private nextAlarm: number | null | undefined = undefined;
  /** rides whose Postgres insert is in flight right now */
  private creating = new Set<string>();
  /** per-ride queue: actions that change a ride's status run one at a time, in arrival order */
  private lanes = new Map<string, Promise<unknown>>();
  /** rides whose pending transition is being sent to Postgres right now (callers share the answer) */
  private committing = new Map<string, Promise<Result<{ ride: HotRide; changed: boolean }>>>();
  /** rides with a settlement call in flight (the inline attempt and the timer must not overlap) */
  private settling = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = loadConfig(env);
    this.sql = ctx.storage.sql;
    this.gridPrecision = Math.max(...this.cfg.match.ringPrecisions);
    this.initSchema();
    this.zone = (ctx.id.name as string | undefined) ?? this.meta("zone");
    this.registered = this.meta("registered") === "1";
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    this.loadPositions();
    void ctx.blockConcurrencyWhile(() => this.rearmTimers());
  }

  /**
   * On every start: work that waits on Postgres must always have its timer, and the alarm must be
   * set for the earliest timer. A crash between writing a timer row and setting the alarm, or while
   * a timer was running (its row is deleted first), must not leave work nothing will pick up.
   */
  private async rearmTimers() {
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
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM timers").one().at;
    if (next === null) return;
    const cur = await this.ctx.storage.getAlarm();
    this.nextAlarm = cur;
    if (cur === null || next < cur) {
      this.nextAlarm = next;
      await this.ctx.storage.setAlarm(next);
    }
  }

  /** Rebuild the in-memory positions from the last snapshot (after eviction / restart). */
  private loadPositions() {
    const rows = this.sql
      .exec<{ id: string; lat: number; lng: number; heading: number | null; updated_at: number }>(
        "SELECT id, lat, lng, heading, updated_at FROM drivers WHERE lat IS NOT NULL AND lng IS NOT NULL",
      )
      .toArray();
    for (const r of rows) this.setPos(r.id, r.lat, r.lng, r.heading, r.updated_at, r.updated_at);
  }

  private initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT,
        lat REAL, lng REAL, heading REAL, cell TEXT,
        status TEXT NOT NULL, ride_id TEXT, reserved_until INTEGER, offer TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drivers_cell ON drivers (cell);
      CREATE TABLE IF NOT EXISTS rides (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, customer_id TEXT NOT NULL, driver_id TEXT,
        data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ride_idem (customer_id TEXT NOT NULL, key TEXT NOT NULL, ride_id TEXT NOT NULL,
        PRIMARY KEY (customer_id, key));
      CREATE TABLE IF NOT EXISTS timers (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      -- replaced by Postgres-first transitions (HotRide.pending); never deployed with data that matters
      DROP TABLE IF EXISTS outbox;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  // ============================================================ helpers

  private learnZone(zone: string | null) {
    if (!zone) return;
    if (this.zone !== zone) {
      this.zone = zone;
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('zone', ?)", zone);
    }
    if (!this.registered) {
      // record this zone actor in Postgres once, so it can be enumerated (ops, dev reset)
      this.registered = true;
      void this.pg((sql) => db.registerZone(sql, zone)).then(
        () => this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('registered', '1')"),
        (e) => {
          this.registered = false; // try again on the next call
          console.error("zone register failed", e);
        },
      );
    }
  }

  /** Dev only: drop every socket (code 4002 → clients log out) and all hot state. */
  async reset(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4002, "reset");
      } catch {
        /* already closed */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.initSchema();
    this.zone = this.ctx.id.name ?? null;
    this.registered = false;
    this.dispatching.clear();
    this.pos.clear();
    this.grid.clear();
    this.nextAlarm = null;
    this.creating.clear();
    this.committing.clear();
    this.lanes.clear();
    this.settling.clear();
  }

  /** Every Postgres call of this actor goes through here (one seam; tests simulate outages with it). */
  private pg<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return withDb(this.env, fn);
  }

  private zoneOf(lat: number, lng: number) {
    return geohashEncode(lat, lng, this.cfg.zonePrecision);
  }

  private stub(zone: string): ZoneApi {
    if (zone === this.zone) return this;
    return zoneStub(this.env, zone) as unknown as ZoneApi;
  }

  private send(userId: string, msg: ServerMsg): number {
    const sockets = this.ctx.getWebSockets(`user:${userId}`);
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* socket closing */
      }
    }
    return sockets.length;
  }

  private sendWs(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }

  private connected(userId: string) {
    return this.ctx.getWebSockets(`user:${userId}`).length > 0;
  }

  // ------------------------------------------------------------ timers (DO alarm multiplexed)

  private async schedule(key: string, at: number) {
    this.sql.exec("INSERT OR REPLACE INTO timers (key, at) VALUES (?, ?)", key, at);
    if (this.nextAlarm === undefined) this.nextAlarm = await this.ctx.storage.getAlarm();
    if (this.nextAlarm === null || at < this.nextAlarm) {
      this.nextAlarm = at;
      await this.ctx.storage.setAlarm(at);
    }
  }

  private cancelTimer(key: string) {
    this.sql.exec("DELETE FROM timers WHERE key = ?", key);
  }

  /**
   * Fires every due timer. Timers of different rides run concurrently (bounded), timers of the
   * same ride run in order — so one slow RPC / database call doesn't delay every other ride.
   */
  async alarm() {
    this.nextAlarm = null; // the alarm that fired is consumed
    const now = Date.now();
    const due = this.sql.exec<{ key: string }>("SELECT key FROM timers WHERE at <= ? ORDER BY at", now).toArray();
    const byRide = new Map<string, string[]>();
    for (const { key } of due) {
      const id = key.slice(key.indexOf(":") + 1);
      byRide.set(id, [...(byRide.get(id) ?? []), key]);
    }
    await runLimited([...byRide.values()], ALARM_CONCURRENCY, async (keys) => {
      for (const key of keys) await this.runTimer(key);
    });
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM timers").one().at;
    if (next !== null && (this.nextAlarm === null || next < this.nextAlarm)) {
      this.nextAlarm = next;
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async runTimer(key: string) {
    this.sql.exec("DELETE FROM timers WHERE key = ?", key);
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    try {
      if (kind === "dispatch") await this.dispatch(id);
      else if (kind === "offer") await this.onOfferTimeout(id);
      else if (kind === "search") await this.onSearchTimeout(id);
      else if (kind === "sync") await this.push(id, "recover");
      else if (kind === "settle") await this.settleFromTimer(id);
      else if (kind === "create") await this.recoverCreate(id);
      else if (kind === "purge") this.purge();
    } catch (err) {
      console.error("timer failed", key, err);
    }
  }

  private purge() {
    const now = Date.now();
    this.sql.exec(
      // keep a ride while Postgres still owes it a write or a settlement
      `DELETE FROM rides WHERE status IN ('COMPLETED','CANCELLED','NO_DRIVER') AND updated_at < ?
         AND json_extract(data, '$.pending') IS NULL
         AND NOT (status = 'COMPLETED' AND json_extract(data, '$.paidAt') IS NULL)`,
      now - KEEP_TERMINAL_MS,
    );
    this.sql.exec(
      "DELETE FROM ride_idem WHERE ride_id NOT IN (SELECT id FROM rides)",
    );
    const gone = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM drivers WHERE status IN ('OFFLINE','AVAILABLE') AND updated_at < ?",
        now - KEEP_IDLE_DRIVER_MS,
      )
      .toArray();
    for (const { id } of gone) if ((this.pos.get(id)?.ts ?? 0) < now - KEEP_IDLE_DRIVER_MS) this.removeDriver(id);
    const left = this.sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM rides) + (SELECT COUNT(*) FROM drivers) AS n").one().n;
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
  }

  private view(r: HotRide): RideView {
    const {
      idempotencyKey: _k, queue: _q, rejected: _r, offer: _o, searched: _s, researched: _rs, searchDeadline: _d,
      pgPending: _p, settleAttempts: _a, pending: _t, pgVersion: _v, ...v
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
      if (res.current.status !== ride.status && event) {
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
    const fields = ride as unknown as Record<string, unknown>;
    for (const k of PG_FIELDS) fields[k] = src[k];
    const offer = ride.offer;
    if (event !== "ARRIVE" && event !== "START" && event !== "COMPLETE") {
      ride.offer = null;
      ride.queue = [];
      for (const k of ["offer", "search", "dispatch"]) this.cancelTimer(`${k}:${ride.id}`);
    }
    this.saveRide(ride);
    // same storage step as the save above: an unsettled completion always has its retry timer
    if (event === "COMPLETE" && !settled) await this.schedule(`settle:${ride.id}`, Date.now() + retryDelay(1));

    if (event === "ACCEPT" && ride.driverId) {
      // The driver now lives in the ride's zone for the whole trip (one actor per active ride).
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
    const freed = event === "CANCEL" && ride.driverId ? this.loadDriver(ride.driverId) : null;
    if (freed && freed.rideId === ride.id) {
      this.setDriverFree(freed);
      freed.updatedAt = Date.now();
      this.saveDriver(freed);
    }

    this.notifyRide(ride);
    if (offer && offer.driverId !== ride.driverId)
      await this.stub(offer.zone).release(offer.driverId, ride.id, event === "NO_CANDIDATE" ? "NO_DRIVER" : "CANCELLED");
    if (freed) {
      const d = this.loadDriver(freed.id);
      if (d) {
        this.sendDriverState(d);
        this.maybeHandOff(d);
      }
    }
    if (event === "COMPLETE") await this.completeRide(ride, settled);
    return this.loadRide(ride.id) ?? ride;
  }

  /** A search that was paused for a transition that did not happen goes on. */
  private async resumeDispatch(ride: HotRide) {
    if (ACTIVE_DISPATCH.has(ride.status) && !ride.offer && !ride.pgPending) await this.schedule(`dispatch:${ride.id}`, Date.now());
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

  // ------------------------------------------------------------ hot store: drivers

  // ------------------------------------------------------------ driver positions (memory + grid)

  private setPos(id: string, lat: number, lng: number, heading: number | null, ts: number, savedAt?: number) {
    const cell = geohashEncode(lat, lng, this.gridPrecision);
    const prev = this.pos.get(id);
    if (prev && prev.cell !== cell) this.grid.get(prev.cell)?.delete(id);
    if (!prev || prev.cell !== cell) {
      let set = this.grid.get(cell);
      if (!set) this.grid.set(cell, (set = new Set()));
      set.add(id);
    }
    this.pos.set(id, { lat, lng, heading, ts, cell, savedAt: savedAt ?? prev?.savedAt ?? 0, outside: prev?.outside ?? 0 });
  }

  private dropPos(id: string) {
    const p = this.pos.get(id);
    if (!p) return;
    const set = this.grid.get(p.cell);
    set?.delete(id);
    if (set?.size === 0) this.grid.delete(p.cell);
    this.pos.delete(id);
  }

  private removeDriver(id: string) {
    this.sql.exec("DELETE FROM drivers WHERE id = ?", id);
    this.dropPos(id);
  }

  // ------------------------------------------------------------ hot store: drivers

  /** Driver row from SQLite with the live in-memory position laid over it. */
  private loadDriver(id: string): DriverRow | null {
    const r = this.sql.exec("SELECT * FROM drivers WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    const p = this.pos.get(id);
    return {
      id: r.id as string,
      name: r.name as string,
      vehicle: r.vehicle ? (JSON.parse(r.vehicle as string) as Vehicle) : null,
      lat: p?.lat ?? (r.lat as number | null),
      lng: p?.lng ?? (r.lng as number | null),
      heading: p ? p.heading : (r.heading as number | null),
      status: r.status as DriverStatus,
      rideId: r.ride_id as string | null,
      reservedUntil: r.reserved_until as number | null,
      offer: r.offer ? (JSON.parse(r.offer as string) as OfferPayload) : null,
      updatedAt: Math.max(r.updated_at as number, p?.ts ?? 0),
    };
  }

  /** Writes the full row (status changes + position snapshot). Location pings do NOT call this. */
  private saveDriver(d: DriverRow) {
    const now = Date.now();
    const cell = d.lat !== null && d.lng !== null ? geohashEncode(d.lat, d.lng, this.gridPrecision) : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO drivers (id, name, vehicle, lat, lng, heading, cell, status, ride_id, reserved_until, offer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id, d.name, d.vehicle ? JSON.stringify(d.vehicle) : null, d.lat, d.lng, d.heading, cell, d.status,
      d.rideId, d.reservedUntil, d.offer ? JSON.stringify(d.offer) : null, d.updatedAt,
    );
    if (d.lat !== null && d.lng !== null) this.setPos(d.id, d.lat, d.lng, d.heading, d.updatedAt, now);
  }

  private setDriverFree(d: DriverRow) {
    d.status = "AVAILABLE";
    d.rideId = null;
    d.reservedUntil = null;
    d.offer = null;
  }

  private sendDriverState(d: DriverRow) {
    this.send(d.id, { t: "driver.state", status: d.status, rideId: d.rideId });
  }

  /**
   * An AVAILABLE driver outside this zone is handed to the zone it is in now — once clearly inside
   * it, or after several pings outside (hysteresis: GPS jitter on a border must not loop reconnects).
   */
  private maybeHandOff(d: DriverRow): boolean {
    if (d.status !== "AVAILABLE" || d.lat === null || d.lng === null || !this.zone) return false;
    const z = this.zoneOf(d.lat, d.lng);
    const p = this.pos.get(d.id);
    if (z === this.zone) {
      if (p) p.outside = 0;
      return false;
    }
    const outside = (p?.outside ?? 0) + 1;
    if (p) p.outside = outside;
    if (!shouldHandOff({ lat: d.lat, lng: d.lng }, z, outside, this.cfg.presence)) return false;
    this.removeDriver(d.id);
    for (const ws of this.ctx.getWebSockets(`user:${d.id}`)) {
      this.sendWs(ws, { t: "zone.moved", zone: z });
      ws.close(4001, "zone moved");
    }
    return true;
  }

  // ============================================================ RPC: matching across zones

  /** Drivers in `cells` from the in-memory grid (no table scan), then their status by primary key. */
  async nearest(cells: string[], pickup: Place, exclude: string[]): Promise<Candidate[]> {
    const ids = new Set<string>();
    for (const cell of cells) {
      const keys = cell.length >= this.gridPrecision ? [cell.slice(0, this.gridPrecision)] : geohashChildren(cell, this.gridPrecision);
      for (const k of keys) for (const id of this.grid.get(k) ?? []) ids.add(id);
    }
    if (ids.size === 0) return [];
    const rows = this.sql
      .exec<{ id: string; status: string; reserved_until: number | null }>(
        "SELECT id, status, reserved_until FROM drivers WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify([...ids]),
      )
      .toArray();
    const drivers: DriverSnapshot[] = [];
    for (const r of rows) {
      const p = this.pos.get(r.id);
      if (!p || !this.connected(r.id)) continue;
      drivers.push({
        id: r.id,
        lat: p.lat,
        lng: p.lng,
        status: r.status as DriverStatus,
        reservedUntil: r.reserved_until,
        updatedAt: p.ts,
      });
    }
    return rankCandidates(pickup, drivers, { now: Date.now(), exclude: new Set(exclude), cfg: this.cfg.match });
  }

  /** Atomic reservation (single writer): only an AVAILABLE, connected driver can be reserved. */
  async reserveAndOffer(driverId: string, offer: OfferPayload, ttlMs: number): Promise<boolean> {
    const d = this.loadDriver(driverId);
    const now = Date.now();
    if (!d) return false;
    const free = d.status === "AVAILABLE" || (d.status === "RESERVED" && (d.reservedUntil ?? 0) < now);
    if (!free || !this.connected(driverId)) return false;
    d.status = "RESERVED";
    d.rideId = offer.rideId;
    d.reservedUntil = now + ttlMs;
    d.offer = offer;
    this.saveDriver(d);
    this.send(driverId, { t: "offer", ...offer });
    return true;
  }

  async release(driverId: string, rideId: string, reason: string): Promise<void> {
    const d = this.loadDriver(driverId);
    if (!d || d.status !== "RESERVED" || d.rideId !== rideId) return;
    this.setDriverFree(d);
    this.saveDriver(d);
    this.send(driverId, { t: "offer.cancelled", rideId, reason });
    this.maybeHandOff(d);
  }

  // ============================================================ RPC: ride lifecycle (ride's zone)

  async createRide(zone: string, input: CreateRideInput): Promise<Result<{ ride: RideView }>> {
    this.learnZone(zone);
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
      id: `${zone}_${crypto.randomUUID().replaceAll("-", "")}`,
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
      searched: false,
      researched: false,
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

  /** Sequential offering: reserve next candidate, offer, wait for accept / reject / timeout. */
  private async dispatch(rideId: string): Promise<void> {
    if (this.dispatching.has(rideId)) return;
    this.dispatching.add(rideId);
    try {
      for (;;) {
        let ride = this.loadRide(rideId);
        // a pending transition (cancel / no driver) pauses the search; resumeDispatch picks it up again
        if (!ride || ride.pgPending || ride.pending || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) return;
        if (Date.now() >= ride.searchDeadline) return this.noDriver(rideId);

        if (ride.queue.length === 0) {
          if (ride.searched && ride.researched) return this.noDriver(rideId);
          if (ride.searched) ride.researched = true;
          ride.searched = true;
          const found = await this.findCandidates(ride);
          ride = this.loadRide(rideId);
          if (!ride || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) return;
          ride.queue = found;
          this.saveRide(ride);
          if (found.length === 0) {
            if (ride.researched) return this.noDriver(rideId);
            // nobody nearby right now: search once more shortly (drivers may come online)
            ride.researched = true;
            this.saveRide(ride);
            await this.schedule(`dispatch:${rideId}`, Date.now() + this.cfg.researchDelayMs);
            return;
          }
        }

        const c = ride.queue.shift()!;
        this.saveRide(ride);
        const offer: OfferPayload = {
          rideId,
          pickup: ride.pickup,
          dropoff: ride.dropoff,
          fare: ride.fare,
          distanceM: ride.distanceM,
          paymentMethod: ride.paymentMethod,
          expiresAt: Date.now() + this.cfg.offerTimeoutMs,
        };
        const reserved = await this.stub(c.zone).reserveAndOffer(c.driverId, offer, this.cfg.reserveTtlMs);

        ride = this.loadRide(rideId);
        if (!ride || ride.pending || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) {
          // cancelled (or otherwise moved on) while we were reserving
          if (reserved) await this.stub(c.zone).release(c.driverId, rideId, "CANCELLED");
          return;
        }
        if (!reserved) continue; // busy / gone: next candidate

        const first = ride.status === "REQUESTED";
        this.transition(ride, { type: "OFFER" });
        ride.offer = { driverId: c.driverId, zone: c.zone, expiresAt: offer.expiresAt };
        this.saveRide(ride);
        await this.schedule(`offer:${rideId}`, offer.expiresAt);
        // OFFERING is this actor's own detail of searching: Postgres keeps the ride REQUESTED
        if (first) this.notifyRide(ride);
        return;
      }
    } finally {
      this.dispatching.delete(rideId);
    }
  }

  /** Rings of geohash cells (fine → coarse), each fanned out to the zones that own them. */
  private async findCandidates(ride: HotRide): Promise<(Candidate & { zone: string })[]> {
    const exclude = ride.rejected;
    for (const precision of this.cfg.match.ringPrecisions) {
      const cells = searchCells(ride.pickup, precision);
      const byZone = new Map<string, string[]>();
      for (const cell of cells) {
        const z = cell.slice(0, this.cfg.zonePrecision);
        byZone.set(z, [...(byZone.get(z) ?? []), cell]);
      }
      const lists = await Promise.all(
        [...byZone].map(async ([zone, zcells]) =>
          (await this.stub(zone).nearest(zcells, ride.pickup, exclude)).map((c) => ({ ...c, zone })),
        ),
      );
      const merged = lists.flat().sort((a, b) => a.distanceM - b.distanceM).slice(0, this.cfg.match.k);
      if (merged.length) return merged;
    }
    return [];
  }

  /** Search is over without a driver. If Postgres can't record it now, the `sync:` timer will. */
  private noDriver(rideId: string): Promise<void> {
    return this.serial(rideId, async () => {
      const ride = this.loadRide(rideId);
      if (!ride || ride.pending || !ACTIVE_DISPATCH.has(ride.status)) return;
      const res = await this.commit(rideId, { type: "NO_CANDIDATE" }, () => {});
      if (!res.ok) console.error("no driver: not recorded yet", rideId, res.code);
    });
  }

  private async onOfferTimeout(rideId: string) {
    const ride = this.loadRide(rideId);
    if (!ride?.offer || ride.status !== "OFFERING") return;
    // an accept / cancel is on its way to Postgres: let it conclude first
    if (ride.pending) return void (await this.schedule(`offer:${rideId}`, Date.now() + CREATE_RECOVERY_MS));
    if (Date.now() < ride.offer.expiresAt) return void (await this.schedule(`offer:${rideId}`, ride.offer.expiresAt));
    const o = ride.offer;
    ride.offer = null;
    ride.rejected.push(o.driverId);
    this.saveRide(ride);
    await this.stub(o.zone).release(o.driverId, rideId, "TIMEOUT");
    await this.dispatch(rideId);
  }

  private async onSearchTimeout(rideId: string) {
    await this.noDriver(rideId);
  }

  async offerRejected(rideId: string, driverId: string): Promise<void> {
    this.learnZone(zoneOfRide(rideId));
    const ride = this.loadRide(rideId);
    if (!ride || ride.offer?.driverId !== driverId || ride.pending?.event === "ACCEPT") return;
    this.dropOffer(ride, driverId);
    await this.dispatch(rideId);
  }

  /** The offered driver is out (rejected, busy elsewhere): never offer them this ride again. */
  private dropOffer(ride: HotRide, driverId: string) {
    ride.offer = null;
    ride.rejected.push(driverId);
    this.saveRide(ride);
    this.cancelTimer(`offer:${ride.id}`);
  }

  async acceptOffer(
    rideId: string,
    driver: DriverInfo & { lat: number | null; lng: number | null; heading: number | null },
  ): Promise<Result<{ ride: RideView }>> {
    this.learnZone(zoneOfRide(rideId));
    let busy = false;
    const res = await this.serial(rideId, async (): Promise<Result<{ ride: RideView }>> => {
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
          this.dropOffer(cur, driver.id);
          busy = true;
        }
        return c;
      }
      return { ok: true, ride: this.view(c.ride) };
    });
    if (busy) await this.dispatch(rideId); // outside the lane: dispatch may record NO_DRIVER through it
    return res;
  }

  async cancelRide(rideId: string, userId: string, role: Role, reason: string): Promise<Result<{ ride: RideView }>> {
    this.learnZone(zoneOfRide(rideId));
    return this.serial(rideId, async () => {
      const r = await this.ready(rideId);
      if (!r.ok) return r;
      const ride = r.ride;
      if (role === "customer" ? ride.customerId !== userId : ride.driverId !== userId) return fail("FORBIDDEN");
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

  private driverRideEvent(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<void> {
    return this.serial(rideId, () => this.driverRideEventNow(driverId, rideId, type));
  }

  private async driverRideEventNow(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<void> {
    const r = await this.ready(rideId);
    if (!r.ok) throw new DomainError(r.code, r.message);
    if (r.ride.driverId !== driverId) throw new DomainError("FORBIDDEN");
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
   * The trip is over (settled in the same Postgres transaction when `settled` is given). Free the
   * driver whatever happens — a failed settlement must not keep the driver stuck ON_RIDE; the
   * `settle:` timer keeps retrying it.
   */
  private async completeRide(ride: HotRide, settled: db.SettleResult | null) {
    const driverId = ride.driverId!;
    const balance = settled ? this.applyPaid(ride.id, settled) : await this.settle(ride.id);
    const d = this.loadDriver(driverId);
    if (!d || d.rideId !== ride.id) return;
    this.setDriverFree(d);
    if (balance !== null && balance < this.cfg.driverMinBalance) {
      d.status = "OFFLINE";
      this.send(driverId, { t: "error", code: "DRIVER_BALANCE_TOO_LOW", message: "top up before going online again" });
    }
    d.updatedAt = Date.now();
    this.saveDriver(d);
    this.sendDriverState(d);
    this.maybeHandOff(d);
  }

  /** Retry path (timer / repeated "complete"): settle, then apply the driver balance rule if they are idle. */
  private async settleFromTimer(rideId: string) {
    const driverId = this.loadRide(rideId)?.driverId;
    const balance = await this.settle(rideId);
    if (balance === null || !driverId || balance >= this.cfg.driverMinBalance) return;
    const d = this.loadDriver(driverId);
    if (!d || d.status !== "AVAILABLE") return; // on another ride / offline: checked again when going online
    d.status = "OFFLINE";
    d.updatedAt = Date.now();
    this.saveDriver(d);
    this.send(driverId, { t: "error", code: "DRIVER_BALANCE_TOO_LOW", message: "top up before going online again" });
    this.sendDriverState(d);
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

  // ============================================================ WebSocket (hibernation API)

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const zone = req.headers.get("x-zone");
    const userId = req.headers.get("x-user-id");
    const role = req.headers.get("x-role") as Role | null;
    const name = decodeURIComponent(req.headers.get("x-user-name") ?? "");
    if (!zone || !userId || !role) return new Response("bad request", { status: 400 });
    this.learnZone(zone);

    // one live socket per user per zone
    for (const old of this.ctx.getWebSockets(`user:${userId}`)) old.close(4000, "replaced");

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.serializeAttachment({ userId, role, name } satisfies SocketMeta);

    let driverStatus: DriverStatus | undefined;
    let rideId: string | null = null;
    if (role === "driver") {
      const lat = Number(req.headers.get("x-lat"));
      const lng = Number(req.headers.get("x-lng"));
      const hasLoc = req.headers.has("x-lat") && isValidLatLng({ lat, lng });
      let d = this.loadDriver(userId);
      if (!d) {
        // adopt a driver whose active ride lives here (reconnect / zone hand-over after accept)
        const active = this.sql
          .exec<{ id: string }>("SELECT id FROM rides WHERE driver_id = ? AND status IN ('ACCEPTED','ARRIVED','ON_TRIP')", userId)
          .toArray()[0];
        d = {
          id: userId, name, vehicle: null, lat: null, lng: null, heading: null,
          status: active ? "ON_RIDE" : "OFFLINE", rideId: active?.id ?? null, reservedUntil: null, offer: null, updatedAt: Date.now(),
        };
      }
      if (hasLoc) {
        d.lat = lat;
        d.lng = lng;
        d.updatedAt = Date.now();
      }
      this.saveDriver(d);
      driverStatus = d.status;
      rideId = d.rideId;
    } else {
      rideId = this.sql
        .exec<{ id: string }>("SELECT id FROM rides WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1", userId)
        .toArray()[0]?.id ?? null;
    }
    this.sendWs(server, { t: "hello", zone, role, driverStatus, rideId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const meta = ws.deserializeAttachment() as SocketMeta;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMsg;
      if (typeof msg?.t !== "string") throw new Error();
    } catch {
      return this.sendWs(ws, { t: "error", code: "BAD_REQUEST", message: "invalid json message" });
    }
    try {
      await this.handle(ws, meta, msg);
    } catch (e) {
      const code = e instanceof DomainError ? e.code : "BAD_REQUEST";
      if (!(e instanceof DomainError)) console.error("ws handler error", e);
      this.sendWs(ws, { t: "error", code, message: (e as Error).message });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      /* already closed */
    }
    // Driver row is kept: stale filter (30s) + socket check exclude it from matching,
    // and a reconnect within that window resumes seamlessly.
  }

  private async handle(ws: WebSocket, meta: SocketMeta, msg: ClientMsg) {
    if (msg.t === "ping") return this.sendWs(ws, { t: "pong" });
    if (msg.t === "resume") return this.resume(ws, meta, msg.rideId);
    if (meta.role !== "driver") throw new DomainError("FORBIDDEN", `${msg.t} is driver-only`);

    const d = this.loadDriver(meta.userId);
    if (!d) {
      // socket outlived its row (handed off): ask client to reconnect by location
      this.sendWs(ws, { t: "zone.moved", zone: this.zone ?? "" });
      return ws.close(4001, "zone moved");
    }

    // ride events for another zone's ride: point the driver there
    if ("rideId" in msg && msg.rideId && msg.t.startsWith("ride.")) {
      const rz = zoneOfRide(msg.rideId);
      if (rz && rz !== this.zone) {
        this.sendWs(ws, { t: "zone.moved", zone: rz, rideId: msg.rideId });
        return ws.close(4001, "zone moved");
      }
    }

    switch (msg.t) {
      case "online": {
        if (d.status === "ON_RIDE" || d.status === "RESERVED") return this.sendDriverState(d);
        if (d.lat === null || d.lng === null) throw new DomainError("BAD_REQUEST", "send a loc first");
        const { balance, vehicle } = await this.pg(async (sql) => ({
          balance: await db.getBalance(sql, d.id),
          vehicle: d.vehicle ?? (await db.getVehicle(sql, d.id)),
        }));
        if (balance < this.cfg.driverMinBalance) throw new DomainError("DRIVER_BALANCE_TOO_LOW", `balance ${balance}`);
        const fresh = this.loadDriver(d.id) ?? d;
        if (fresh.status !== "OFFLINE" && fresh.status !== "AVAILABLE") return this.sendDriverState(fresh);
        fresh.vehicle ??= vehicle;
        fresh.status = "AVAILABLE";
        fresh.updatedAt = Date.now();
        this.saveDriver(fresh);
        this.sendDriverState(fresh);
        this.maybeHandOff(fresh);
        return;
      }
      case "offline": {
        if (d.status === "ON_RIDE") throw new DomainError("DRIVER_BUSY", "finish the ride first");
        const pending = d.status === "RESERVED" ? d.rideId : null;
        d.status = "OFFLINE";
        d.rideId = null;
        d.offer = null;
        d.reservedUntil = null;
        this.saveDriver(d);
        this.sendDriverState(d);
        if (pending) await this.stub(zoneOfRide(pending)!).offerRejected(pending, d.id);
        return;
      }
      case "loc": {
        if (!isValidLatLng(msg)) throw new DomainError("BAD_REQUEST", "invalid lat/lng");
        const now = Date.now();
        const prev = this.pos.get(d.id);
        const last = prev ? { lat: prev.lat, lng: prev.lng, at: prev.ts } : null;
        if (!acceptPing(last, { lat: msg.lat, lng: msg.lng, at: now }, d.status === "ON_RIDE", this.cfg.presence)) return; // throttled
        d.lat = msg.lat;
        d.lng = msg.lng;
        d.heading = typeof msg.heading === "number" ? msg.heading : d.heading;
        d.updatedAt = now;
        // memory only; SQLite gets a snapshot at most every SNAPSHOT_MS
        this.setPos(d.id, d.lat, d.lng, d.heading, now);
        if (now - (this.pos.get(d.id)?.savedAt ?? 0) >= SNAPSHOT_MS) this.saveDriver(d);
        if (d.status === "ON_RIDE" && d.rideId) {
          const ride = this.loadRide(d.rideId);
          if (ride) this.send(ride.customerId, { t: "driver.loc", rideId: ride.id, lat: d.lat, lng: d.lng, heading: d.heading });
        } else {
          this.maybeHandOff(d);
        }
        return;
      }
      case "offer.accept": {
        if (d.status === "ON_RIDE" && d.rideId === msg.rideId) return this.resume(ws, meta, msg.rideId);
        if (d.status !== "RESERVED" || d.rideId !== msg.rideId) throw new DomainError("OFFER_EXPIRED");
        const rideZone = zoneOfRide(msg.rideId);
        if (!rideZone) throw new DomainError("RIDE_NOT_FOUND");
        const res = await this.stub(rideZone).acceptOffer(msg.rideId, {
          id: d.id, name: d.name, vehicle: d.vehicle, lat: d.lat, lng: d.lng, heading: d.heading,
        });
        if (!res.ok) {
          const cur = this.loadDriver(d.id);
          // UNAVAILABLE: the accept may still land (Postgres outcome unknown) — keep the reservation so the
          // driver can retry; the ride's zone releases it if the accept turns out not to have happened
          if (cur && cur.status === "RESERVED" && cur.rideId === msg.rideId && res.code !== "UNAVAILABLE") {
            this.setDriverFree(cur);
            this.saveDriver(cur);
          }
          throw new DomainError(res.code, res.message);
        }
        if (rideZone !== this.zone) {
          // hand the driver over to the ride's zone for the trip
          const cur = this.loadDriver(d.id);
          if (cur && cur.rideId === msg.rideId) this.removeDriver(d.id);
          this.sendWs(ws, { t: "ride.status", rideId: res.ride.id, status: res.ride.status, driver: res.ride.driver, at: Date.now(), ride: res.ride });
          this.sendWs(ws, { t: "zone.moved", zone: rideZone, rideId: msg.rideId });
          ws.close(4001, "zone moved");
        }
        return;
      }
      case "offer.reject": {
        if (d.status !== "RESERVED" || d.rideId !== msg.rideId) return; // late / duplicate: no-op
        this.setDriverFree(d);
        this.saveDriver(d);
        this.sendDriverState(d);
        await this.stub(zoneOfRide(msg.rideId)!).offerRejected(msg.rideId, d.id);
        this.maybeHandOff(this.loadDriver(d.id) ?? d);
        return;
      }
      case "ride.arrived":
        return this.driverRideEvent(d.id, msg.rideId, "ARRIVE");
      case "ride.start":
        return this.driverRideEvent(d.id, msg.rideId, "START");
      case "ride.complete":
        return this.driverRideEvent(d.id, msg.rideId, "COMPLETE");
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
      const rz = zoneOfRide(rideId);
      if (rz && rz !== this.zone) return this.sendWs(ws, { t: "zone.moved", zone: rz, rideId });
      return this.sendWs(ws, { t: "error", code: "RIDE_NOT_FOUND", message: rideId });
    }
    if (ride.customerId !== meta.userId && ride.driverId !== meta.userId) {
      return this.sendWs(ws, { t: "error", code: "FORBIDDEN", message: rideId });
    }
    this.sendWs(ws, { t: "ride.status", rideId, status: ride.status, driver: ride.driver, at: Date.now(), ride: this.view(ride) });
  }
}
