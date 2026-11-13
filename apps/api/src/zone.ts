import { DurableObject } from "cloudflare:workers";
import {
  applyRideEvent,
  type Candidate,
  DomainError,
  type DriverSnapshot,
  type DriverStatus,
  estimate,
  geohashEncode,
  isValidLatLng,
  type PaymentMethod,
  type Place,
  rankCandidates,
  type RideEvent,
  type Role,
  searchCells,
} from "@gojek/core";
import { type Config, loadConfig, zoneOfRide } from "./config";
import { getBalance, getVehicle, settleRide, upsertRideStmt } from "./db";
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

/**
 * Zone actor: single writer for every driver and ride in one geohash zone.
 * Hot state lives in this DO's SQLite (survives hibernation); D1 is written through for history.
 */
export class ZoneDO extends DurableObject<Env> implements ZoneApi {
  private cfg: Config;
  private sql: SqlStorage;
  private zone: string | null;
  private registered: boolean;
  private dispatching = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = loadConfig(env);
    this.sql = ctx.storage.sql;
    this.initSchema();
    this.zone = (ctx.id.name as string | undefined) ?? this.meta("zone");
    this.registered = this.meta("registered") === "1";
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
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
      // record this zone actor in D1 once, so it can be enumerated (ops, dev reset)
      this.registered = true;
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('registered', '1')");
      void this.env.DB.prepare("INSERT OR IGNORE INTO zones (zone, first_seen) VALUES (?, ?)").bind(zone, Date.now()).run()
        .catch((e) => console.error("zone register failed", e));
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
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  private cancelTimer(key: string) {
    this.sql.exec("DELETE FROM timers WHERE key = ?", key);
  }

  async alarm() {
    const now = Date.now();
    const due = this.sql.exec<{ key: string }>("SELECT key FROM timers WHERE at <= ? ORDER BY at", now).toArray();
    for (const { key } of due) {
      this.sql.exec("DELETE FROM timers WHERE key = ?", key);
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      try {
        if (kind === "dispatch") await this.dispatch(id);
        else if (kind === "offer") await this.onOfferTimeout(id);
        else if (kind === "search") await this.onSearchTimeout(id);
        else if (kind === "purge") this.purge();
      } catch (err) {
        console.error("timer failed", key, err);
      }
    }
    const next = this.sql.exec<{ at: number }>("SELECT MIN(at) AS at FROM timers").one().at;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  private purge() {
    const now = Date.now();
    this.sql.exec(
      `DELETE FROM rides WHERE status IN ('COMPLETED','CANCELLED','NO_DRIVER') AND updated_at < ?`,
      now - KEEP_TERMINAL_MS,
    );
    this.sql.exec(
      "DELETE FROM ride_idem WHERE ride_id NOT IN (SELECT id FROM rides)",
    );
    this.sql.exec(
      "DELETE FROM drivers WHERE status IN ('OFFLINE','AVAILABLE') AND updated_at < ?",
      now - KEEP_IDLE_DRIVER_MS,
    );
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
    const { idempotencyKey: _k, queue: _q, rejected: _r, offer: _o, searched: _s, researched: _rs, searchDeadline: _d, ...v } = r;
    return v;
  }

  private async persist(r: HotRide) {
    await upsertRideStmt(this.env.DB, this.view(r), r.idempotencyKey).run();
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

  private loadDriver(id: string): DriverRow | null {
    const r = this.sql.exec("SELECT * FROM drivers WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      vehicle: r.vehicle ? (JSON.parse(r.vehicle as string) as Vehicle) : null,
      lat: r.lat as number | null,
      lng: r.lng as number | null,
      heading: r.heading as number | null,
      status: r.status as DriverStatus,
      rideId: r.ride_id as string | null,
      reservedUntil: r.reserved_until as number | null,
      offer: r.offer ? (JSON.parse(r.offer as string) as OfferPayload) : null,
      updatedAt: r.updated_at as number,
    };
  }

  private saveDriver(d: DriverRow) {
    const cell = d.lat !== null && d.lng !== null ? geohashEncode(d.lat, d.lng, Math.max(...this.cfg.match.ringPrecisions)) : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO drivers (id, name, vehicle, lat, lng, heading, cell, status, ride_id, reserved_until, offer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id, d.name, d.vehicle ? JSON.stringify(d.vehicle) : null, d.lat, d.lng, d.heading, cell, d.status,
      d.rideId, d.reservedUntil, d.offer ? JSON.stringify(d.offer) : null, d.updatedAt,
    );
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

  /** An AVAILABLE driver outside this zone is handed to the zone it is in now. */
  private maybeHandOff(d: DriverRow): boolean {
    if (d.status !== "AVAILABLE" || d.lat === null || d.lng === null || !this.zone) return false;
    const z = this.zoneOf(d.lat, d.lng);
    if (z === this.zone) return false;
    this.sql.exec("DELETE FROM drivers WHERE id = ?", d.id);
    for (const ws of this.ctx.getWebSockets(`user:${d.id}`)) {
      this.sendWs(ws, { t: "zone.moved", zone: z });
      ws.close(4001, "zone moved");
    }
    return true;
  }

  // ============================================================ RPC: matching across zones

  async nearest(cells: string[], pickup: Place, exclude: string[]): Promise<Candidate[]> {
    const p = cells[0]?.length ?? 0;
    if (!p) return [];
    const rows = this.sql
      .exec(
        `SELECT id, lat, lng, status, reserved_until, updated_at FROM drivers
         WHERE lat IS NOT NULL AND substr(cell, 1, ?) IN (SELECT value FROM json_each(?))`,
        p,
        JSON.stringify(cells),
      )
      .toArray();
    const drivers: DriverSnapshot[] = rows
      .filter((r) => this.connected(r.id as string))
      .map((r) => ({
        id: r.id as string,
        lat: r.lat as number,
        lng: r.lng as number,
        status: r.status as DriverStatus,
        reservedUntil: r.reserved_until as number | null,
        updatedAt: r.updated_at as number,
      }));
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
      const r = prev && this.loadRide(prev.ride_id);
      if (r) return { ok: true, ride: this.view(r) };
    }
    const active = this.sql
      .exec("SELECT id FROM rides WHERE customer_id = ? AND status IN ('REQUESTED','OFFERING','ACCEPTED','ARRIVED','ON_TRIP')", input.customerId)
      .toArray();
    if (active.length) return fail("ACTIVE_RIDE_EXISTS", "customer already has an active ride");

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
    };
    this.saveRide(ride);
    if (input.idempotencyKey)
      this.sql.exec("INSERT INTO ride_idem (customer_id, key, ride_id) VALUES (?, ?, ?)", input.customerId, input.idempotencyKey, ride.id);
    await this.persist(ride);
    await this.schedule(`search:${ride.id}`, ride.searchDeadline);
    await this.schedule(`dispatch:${ride.id}`, now); // matching runs from the alarm, off the request path
    await this.schedule("purge:all", now + PURGE_EVERY_MS);
    return { ok: true, ride: this.view(ride) };
  }

  /** Sequential offering: reserve next candidate, offer, wait for accept / reject / timeout. */
  private async dispatch(rideId: string): Promise<void> {
    if (this.dispatching.has(rideId)) return;
    this.dispatching.add(rideId);
    try {
      for (;;) {
        let ride = this.loadRide(rideId);
        if (!ride || !ACTIVE_DISPATCH.has(ride.status) || ride.offer) return;
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
    if (!this.transition(ride, { type })) return; // duplicate event: idempotent no-op
    const now = Date.now();
    if (type === "ARRIVE") ride.arrivedAt = now;
    if (type === "START") ride.startedAt = now;
    if (type === "COMPLETE") {
      ride.completedAt = now;
      ride.fareFinal = ride.fare; // fixed upfront price
    }
    this.saveRide(ride);
    await this.persist(ride);
    this.notifyRide(ride);
    if (type === "COMPLETE") await this.completeRide(ride);
  }

  private async completeRide(ride: HotRide) {
    const driverId = ride.driverId!;
    const res = await settleRide(this.env.DB, {
      rideId: ride.id,
      customerId: ride.customerId,
      driverId,
      fare: ride.fareFinal ?? ride.fare,
      paymentMethod: ride.paymentMethod,
      commissionRate: this.cfg.commissionRate,
    });
    ride.paidVia = res.paidVia;
    ride.paidAt = Date.now();
    this.saveRide(ride);
    const fare = ride.fareFinal ?? ride.fare;
    this.send(ride.customerId, { t: "ride.paid", rideId: ride.id, paidVia: res.paidVia, fare, balance: res.customerBalance });
    this.send(driverId, { t: "ride.paid", rideId: ride.id, paidVia: res.paidVia, fare, balance: res.driverBalance });

    const d = this.loadDriver(driverId);
    if (!d || d.rideId !== ride.id) return;
    this.setDriverFree(d);
    if (res.driverBalance < this.cfg.driverMinBalance) {
      d.status = "OFFLINE";
      this.send(driverId, { t: "error", code: "DRIVER_BALANCE_TOO_LOW", message: "top up before going online again" });
    }
    d.updatedAt = Date.now();
    this.saveDriver(d);
    this.sendDriverState(d);
    this.maybeHandOff(d);
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
        const balance = await getBalance(this.env.DB, d.id);
        if (balance < this.cfg.driverMinBalance) throw new DomainError("DRIVER_BALANCE_TOO_LOW", `balance ${balance}`);
        const fresh = this.loadDriver(d.id) ?? d;
        if (fresh.status !== "OFFLINE" && fresh.status !== "AVAILABLE") return this.sendDriverState(fresh);
        fresh.vehicle ??= await getVehicle(this.env.DB, d.id);
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
        d.lat = msg.lat;
        d.lng = msg.lng;
        d.heading = typeof msg.heading === "number" ? msg.heading : d.heading;
        d.updatedAt = Date.now();
        this.saveDriver(d);
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
          if (cur && cur.rideId === msg.rideId) this.sql.exec("DELETE FROM drivers WHERE id = ?", d.id);
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
