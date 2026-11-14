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
  type Role,
  searchCells,
  shouldHandOff,
} from "@gojek/core";
import { type Config, loadConfig, zoneOfRide } from "./config";
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
  /** failed settlement attempts (retried by the `settle:` timer) */
  settleAttempts?: number;
}

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

const ACTIVE_DISPATCH = new Set(["REQUESTED", "OFFERING"]);
const PURGE_EVERY_MS = 10 * 60_000;
const KEEP_TERMINAL_MS = 60 * 60_000;
const KEEP_IDLE_DRIVER_MS = 60 * 60_000;
const SNAPSHOT_MS = 30_000;
const ALARM_CONCURRENCY = 16;
/** a ride still pgPending after this long is checked against Postgres */
const CREATE_RECOVERY_MS = 5_000;

/** Backoff for Postgres retries (outbox flush, settlement): 2 s, 4 s, … capped at 60 s. */
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
  /** per-ride chain so outbox flushes of one ride never overlap (writes reach Postgres in order) */
  private flushChains = new Map<string, Promise<unknown>>();
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
      -- latest ride state not yet written to Postgres (one row per ride, retried until it lands)
      CREATE TABLE IF NOT EXISTS outbox (ride_id TEXT PRIMARY KEY, data TEXT NOT NULL, idem TEXT,
        version INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
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
    this.flushChains.clear();
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
    return this.env.ZONE.get(this.env.ZONE.idFromName(zone)) as unknown as ZoneApi;
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
      else if (kind === "outbox") await this.flushRide(id);
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
         AND id NOT IN (SELECT ride_id FROM outbox)
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
      pgPending: _p, settleAttempts: _a, ...v
    } = r;
    return v;
  }

  /**
   * Write-through of the ride to Postgres via an outbox: the latest state is recorded in this actor's
   * SQLite first (same synchronous step as saveRide), then flushed right away. If Postgres is down
   * the row stays and the `outbox:` timer retries with backoff — the two stores converge, a failed
   * write is never silently dropped. Never throws.
   */
  private async persist(r: HotRide) {
    this.sql.exec(
      `INSERT INTO outbox (ride_id, data, idem, version, attempts, updated_at) VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT (ride_id) DO UPDATE SET data = excluded.data, idem = excluded.idem,
         version = outbox.version + 1, attempts = 0, updated_at = excluded.updated_at`,
      r.id, JSON.stringify(this.view(r)), r.idempotencyKey, Date.now(),
    );
    await this.flushRide(r.id);
  }

  /** Flush one ride's outbox row; calls for the same ride are serialized. Resolves true when nothing is left. */
  private flushRide(rideId: string): Promise<boolean> {
    const prev = this.flushChains.get(rideId) ?? Promise.resolve();
    const run = prev.then(() => this.flushOnce(rideId));
    const tail = run.catch(() => {});
    this.flushChains.set(rideId, tail);
    void tail.then(() => {
      if (this.flushChains.get(rideId) === tail) this.flushChains.delete(rideId);
    });
    return run;
  }

  private async flushOnce(rideId: string): Promise<boolean> {
    const row = this.sql
      .exec<{ data: string; idem: string | null; version: number; attempts: number }>(
        "SELECT data, idem, version, attempts FROM outbox WHERE ride_id = ?", rideId,
      )
      .toArray()[0];
    if (!row) return true;
    try {
      await this.pg((sql) => db.persistRide(sql, JSON.parse(row.data) as RideView, row.idem));
    } catch (e) {
      const attempts = row.attempts + 1;
      console.error("outbox flush failed", rideId, `attempt ${attempts}`, e);
      this.sql.exec("UPDATE outbox SET attempts = ? WHERE ride_id = ? AND version = ?", attempts, rideId, row.version);
      await this.schedule(`outbox:${rideId}`, Date.now() + retryDelay(attempts));
      return false;
    }
    // a newer state enqueued meanwhile keeps its row (and is flushed by its own call)
    this.sql.exec("DELETE FROM outbox WHERE ride_id = ? AND version = ?", rideId, row.version);
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE ride_id = ?", rideId).one().n;
    if (left === 0) this.cancelTimer(`outbox:${rideId}`);
    return left === 0;
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
        if (!ride || ride.pgPending || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) return;
        if (Date.now() >= ride.searchDeadline) return this.noDriver(ride);

        if (ride.queue.length === 0) {
          if (ride.searched && ride.researched) return this.noDriver(ride);
          if (ride.searched) ride.researched = true;
          ride.searched = true;
          const found = await this.findCandidates(ride);
          ride = this.loadRide(rideId);
          if (!ride || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) return;
          ride.queue = found;
          this.saveRide(ride);
          if (found.length === 0) {
            if (ride.researched) return this.noDriver(ride);
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
        if (!ride || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) {
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
        if (first) {
          await this.persist(ride);
          this.notifyRide(ride);
        }
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

  private async noDriver(ride: HotRide) {
    if (ride.offer) {
      const o = ride.offer;
      ride.offer = null;
      this.saveRide(ride);
      await this.stub(o.zone).release(o.driverId, ride.id, "NO_DRIVER");
    }
    if (!this.transition(ride, { type: "NO_CANDIDATE" })) return;
    ride.queue = [];
    this.saveRide(ride);
    this.cancelTimer(`offer:${ride.id}`);
    this.cancelTimer(`search:${ride.id}`);
    this.cancelTimer(`dispatch:${ride.id}`);
    await this.persist(ride);
    this.notifyRide(ride);
  }

  private async onOfferTimeout(rideId: string) {
    const ride = this.loadRide(rideId);
    if (!ride?.offer || ride.status !== "OFFERING") return;
    if (Date.now() < ride.offer.expiresAt) return void (await this.schedule(`offer:${rideId}`, ride.offer.expiresAt));
    const o = ride.offer;
    ride.offer = null;
    ride.rejected.push(o.driverId);
    this.saveRide(ride);
    await this.stub(o.zone).release(o.driverId, rideId, "TIMEOUT");
    await this.dispatch(rideId);
  }

  private async onSearchTimeout(rideId: string) {
    const ride = this.loadRide(rideId);
    if (ride && ACTIVE_DISPATCH.has(ride.status)) await this.noDriver(ride);
  }

  async offerRejected(rideId: string, driverId: string): Promise<void> {
    this.learnZone(zoneOfRide(rideId));
    const ride = this.loadRide(rideId);
    if (!ride || ride.offer?.driverId !== driverId) return;
    ride.offer = null;
    ride.rejected.push(driverId);
    this.saveRide(ride);
    this.cancelTimer(`offer:${rideId}`);
    await this.dispatch(rideId);
  }

  async acceptOffer(
    rideId: string,
    driver: DriverInfo & { lat: number | null; lng: number | null; heading: number | null },
  ): Promise<Result<{ ride: RideView }>> {
    this.learnZone(zoneOfRide(rideId));
    const ride = this.loadRide(rideId);
    if (!ride) return fail("RIDE_NOT_FOUND");
    if (ride.driverId === driver.id && ride.status === "ACCEPTED") return { ok: true, ride: this.view(ride) };
    if (ride.status !== "OFFERING" || ride.offer?.driverId !== driver.id || Date.now() > ride.offer.expiresAt)
      return fail("OFFER_EXPIRED");

    this.transition(ride, { type: "ACCEPT" });
    ride.driverId = driver.id;
    ride.driver = { id: driver.id, name: driver.name, vehicle: driver.vehicle };
    ride.acceptedAt = Date.now();
    ride.offer = null;
    ride.queue = [];
    this.saveRide(ride);
    this.cancelTimer(`offer:${rideId}`);
    this.cancelTimer(`search:${rideId}`);

    // The driver now lives in the ride's zone for the whole trip (one actor per active ride).
    const d = this.loadDriver(driver.id) ?? {
      id: driver.id, name: driver.name, vehicle: driver.vehicle, lat: driver.lat, lng: driver.lng,
      heading: driver.heading, status: "ON_RIDE" as DriverStatus, rideId, reservedUntil: null, offer: null, updatedAt: Date.now(),
    };
    d.status = "ON_RIDE";
    d.rideId = rideId;
    d.reservedUntil = null;
    d.offer = null;
    this.saveDriver(d);

    await this.persist(ride);
    this.notifyRide(ride);
    return { ok: true, ride: this.view(ride) };
  }

  async cancelRide(rideId: string, userId: string, role: Role, reason: string): Promise<Result<{ ride: RideView }>> {
    this.learnZone(zoneOfRide(rideId));
    const ride = this.loadRide(rideId);
    if (!ride) return fail("RIDE_NOT_FOUND");
    if (role === "customer" ? ride.customerId !== userId : ride.driverId !== userId) return fail("FORBIDDEN");
    if (ride.pgPending) return fail("INVALID_TRANSITION", "ride is still being created, try again shortly");
    let changed: boolean;
    try {
      changed = this.transition(ride, { type: "CANCEL", by: role });
    } catch (e) {
      return fail("INVALID_TRANSITION", (e as Error).message);
    }
    if (!changed) return { ok: true, ride: this.view(ride) };

    const offer = ride.offer;
    ride.offer = null;
    ride.queue = [];
    ride.cancelReason = reason || null;
    ride.cancelledBy = role;
    ride.cancelledAt = Date.now();
    this.saveRide(ride);
    for (const k of ["offer", "search", "dispatch"]) this.cancelTimer(`${k}:${rideId}`);

    if (ride.driverId) {
      const d = this.loadDriver(ride.driverId);
      if (d && d.rideId === rideId) {
        this.setDriverFree(d);
        d.updatedAt = Date.now();
        this.saveDriver(d);
      }
    }
    await this.persist(ride);
    this.notifyRide(ride);
    if (offer) await this.stub(offer.zone).release(offer.driverId, rideId, "CANCELLED");
    if (ride.driverId) {
      const d = this.loadDriver(ride.driverId);
      if (d) {
        this.sendDriverState(d);
        this.maybeHandOff(d);
      }
    }
    return { ok: true, ride: this.view(ride) };
  }

  private async driverRideEvent(driverId: string, rideId: string, type: "ARRIVE" | "START" | "COMPLETE"): Promise<void> {
    const ride = this.loadRide(rideId);
    if (!ride) throw new DomainError("RIDE_NOT_FOUND");
    if (ride.driverId !== driverId) throw new DomainError("FORBIDDEN");
    if (!this.transition(ride, { type })) {
      // duplicate event: idempotent no-op — except a repeated "complete" re-drives an unfinished settlement
      if (type === "COMPLETE" && ride.paidAt === null) await this.settleFromTimer(rideId);
      return;
    }
    const now = Date.now();
    if (type === "ARRIVE") ride.arrivedAt = now;
    if (type === "START") ride.startedAt = now;
    if (type === "COMPLETE") {
      ride.completedAt = now;
      ride.fareFinal = ride.fare; // fixed upfront price
    }
    this.saveRide(ride);
    // durable before anything can fail: settlement is retried by this timer until the ride is paid
    if (type === "COMPLETE") await this.schedule(`settle:${rideId}`, now + retryDelay(1));
    await this.persist(ride);
    this.notifyRide(ride);
    if (type === "COMPLETE") await this.completeRide(ride);
  }

  /**
   * The trip is over: try to settle now, and free the driver whatever happens — a failed settlement
   * must not keep the driver stuck ON_RIDE; the `settle:` timer keeps retrying it.
   */
  private async completeRide(ride: HotRide) {
    const driverId = ride.driverId!;
    const balance = await this.settle(ride.id);
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
    const cur = this.loadRide(rideId) ?? ride;
    if (cur.paidAt !== null) return null; // a concurrent attempt already finished (and notified)
    cur.paidVia = res.paidVia;
    cur.paidAt = Date.now();
    this.saveRide(cur);
    this.cancelTimer(`settle:${rideId}`);
    this.send(cur.customerId, { t: "ride.paid", rideId, paidVia: res.paidVia, fare, balance: res.customerBalance });
    this.send(driverId, { t: "ride.paid", rideId, paidVia: res.paidVia, fare, balance: res.driverBalance });
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
          if (cur && cur.status === "RESERVED" && cur.rideId === msg.rideId) {
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
