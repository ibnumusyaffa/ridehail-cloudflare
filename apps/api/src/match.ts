import {
  type Candidate,
  DomainError,
  type DriverSnapshot,
  type DriverStatus,
  geohashChildren,
  type Place,
  rankCandidates,
  shouldHandOff,
} from "@gojek/core";
import { type DriverRow, type PingDriver, PURGE_EVERY_MS, type SocketMeta, ZoneActor } from "./actor";
import { homeOfRide, matchRoute, matchStub, rideRoute, rideStub } from "./config";
import * as db from "./db";
import { type ClientMsg, type DriverInfo, fail, type OfferPayload, type Result, type RideView } from "./protocol";
import type { RideApi } from "./ride";
import { MATCH_MIGRATIONS } from "./schema";

const KEEP_IDLE_DRIVER_MS = 60 * 60_000;
/** how long a driver handed to a ride's actor is remembered here (to forward messages still in flight) */
const MOVED_MEMORY_MS = 60_000;

type RideEventMsg = Extract<ClientMsg, { t: "ride.arrived" | "ride.start" | "ride.complete" }>;
const isRideEvent = (m: ClientMsg): m is RideEventMsg => m.t === "ride.arrived" || m.t === "ride.start" || m.t === "ride.complete";

/** A driver as handed between the actors of a zone. */
export type DriverHandoff = DriverInfo & { lat: number | null; lng: number | null; heading: number | null };

/** Methods ride actors / the Worker call over RPC. Results never throw across the wire. */
export interface MatchApi {
  nearest(cells: string[], pickup: Place, exclude: string[]): Promise<Candidate[]>;
  reserveAndOffer(driverId: string, offer: OfferPayload, ttlMs: number): Promise<boolean>;
  release(driverId: string, rideId: string, reason: string): Promise<void>;
  handOverToRide(driverId: string, rideId: string, rideHome: string): Promise<void>;
  returnDriver(driver: DriverHandoff, status: "AVAILABLE" | "OFFLINE"): Promise<void>;
  reset(): Promise<void>;
}

/**
 * Match actor (`match:<zone>`): single writer for the free drivers of one geohash zone — OFFLINE,
 * AVAILABLE and RESERVED (being offered a ride). Holds their positions in memory (+ a geohash grid),
 * answers searches (`nearest`) and reserves drivers atomically (`reserveAndOffer`).
 *
 * A driver who accepts a ride moves to that ride's actor (`ride:<home>`) for the trip and comes back
 * here (`returnDriver`) when it is over. Rides themselves never live here.
 */
export class MatchDO extends ZoneActor implements MatchApi {
  /** drivers just handed to a ride's actor (memory only): driverId → rideId, until */
  private moved = new Map<string, { rideId: string; until: number }>();
  /** drivers being handed to another zone right now (their `reconnect` is about to go out) */
  private handingOff = new Set<string>();
  /** free drivers only (OFFLINE / AVAILABLE / RESERVED): the idle ping interval */
  protected readonly ridePings = false;

  protected migrations() {
    return MATCH_MIGRATIONS;
  }

  protected async onTimer(kind: string) {
    if (kind === "purge") this.purge();
  }

  override async reset(): Promise<void> {
    await super.reset();
    this.moved.clear();
    this.handingOff.clear();
  }

  /** The ride actor of `home` (see `rideHome`: a zone, or one of its shards). */
  private stub(home: string): RideApi {
    return rideStub(this.env, home) as unknown as RideApi;
  }

  private purge() {
    const now = Date.now();
    const gone = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM drivers WHERE status IN ('OFFLINE','AVAILABLE') AND updated_at < ?",
        now - KEEP_IDLE_DRIVER_MS,
      )
      .toArray();
    for (const { id } of gone) if ((this.pos.get(id)?.ts ?? 0) < now - KEEP_IDLE_DRIVER_MS) this.removeDriver(id);
    for (const [id, m] of this.moved) if (m.until < now) this.moved.delete(id);
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM drivers").one().n;
    if (left > 0) void this.schedule("purge:all", now + PURGE_EVERY_MS);
  }

  /**
   * An AVAILABLE driver outside this zone is handed to the zone it is in now — once clearly inside
   * it, or after several pings outside (hysteresis: GPS jitter on a border must not loop reconnects).
   * The new zone gets the driver AVAILABLE before the client is told to move, so they arrive online
   * (no `online` to resend, no balance check again); if that call fails they arrive OFFLINE there.
   */
  private async maybeHandOff(d: PingDriver): Promise<boolean> {
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
    const full = this.loadDriver(d.id);
    // removed first: from here on this zone can't reserve them (the new one can't either until they connect)
    this.removeDriver(d.id);
    this.handingOff.add(d.id);
    try {
      if (full)
        await (matchStub(this.env, z) as unknown as MatchApi).returnDriver(
          { id: full.id, name: full.name, vehicle: full.vehicle, lat: full.lat, lng: full.lng, heading: full.heading },
          "AVAILABLE",
        );
    } catch (e) {
      console.error("zone hand-over: new zone unreachable, driver arrives OFFLINE", d.id, z, e);
    } finally {
      this.handingOff.delete(d.id);
    }
    this.moveSockets(d.id, matchRoute(z), true);
    return true;
  }

  /** The driver now lives in the ride's actor: forget them here and point their sockets there. */
  private handToRide(driverId: string, rideId: string, rideHome: string) {
    this.removeDriver(driverId);
    this.moved.set(driverId, { rideId, until: Date.now() + MOVED_MEMORY_MS });
    // not closed here: the client closes and reconnects; a message it sends meanwhile is forwarded
    this.moveSockets(driverId, rideRoute(rideHome), false);
  }

  /**
   * The driver has an active ride (Postgres says so) yet is here: hand them to that ride's actor.
   * False when the ride id names no ride actor (nothing done).
   */
  private toActiveRide(driverId: string, rideId: string): boolean {
    const home = homeOfRide(rideId);
    if (!home) return false;
    const d = this.loadDriver(driverId);
    // a reservation they still hold here can't be taken now: the ride's offer timer moves that search on
    if (d?.status === "RESERVED" && d.rideId && d.rideId !== rideId)
      this.send(driverId, { t: "offer.cancelled", rideId: d.rideId, reason: "CANCELLED" });
    this.handToRide(driverId, rideId, home);
    return true;
  }

  // ============================================================ RPC: matching

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

  /**
   * Atomic reservation (single writer): only an AVAILABLE, connected driver can be reserved.
   * Idempotent per ride, so the ride's actor can retry it when the reply was lost.
   */
  async reserveAndOffer(driverId: string, offer: OfferPayload, ttlMs: number): Promise<boolean> {
    const d = this.loadDriver(driverId);
    const now = Date.now();
    if (!d) return false;
    // a retry of a reservation whose reply was lost: same ride, still reserved → offer it again
    const again = d.status === "RESERVED" && d.rideId === offer.rideId;
    const free = again || d.status === "AVAILABLE" || (d.status === "RESERVED" && (d.reservedUntil ?? 0) < now);
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
    await this.maybeHandOff(d);
  }

  /**
   * The driver's accept of `rideId` committed in the ride's actor: they live there for the trip.
   * Normally the driver's own accept already moved them; this covers the accept whose reply was lost
   * (A6). Idempotent.
   */
  async handOverToRide(driverId: string, rideId: string, rideHome: string): Promise<void> {
    const d = this.loadDriver(driverId);
    if (!d) return; // already moved
    // reserved for another ride after this one's reservation lapsed: that offer can't be taken now
    if (d.status === "RESERVED" && d.rideId && d.rideId !== rideId)
      this.send(driverId, { t: "offer.cancelled", rideId: d.rideId, reason: "CANCELLED" });
    this.handToRide(driverId, rideId, rideHome);
  }

  /** A trip is over: the ride's actor hands its driver back (free, or OFFLINE when their balance is too low). */
  async returnDriver(driver: DriverHandoff, status: "AVAILABLE" | "OFFLINE"): Promise<void> {
    this.learnZone(this.zone);
    this.moved.delete(driver.id);
    const cur = this.loadDriver(driver.id);
    // reserved here meanwhile (a socket that never left): keep that reservation
    if (cur?.status === "RESERVED" && (cur.reservedUntil ?? 0) > Date.now()) return;
    this.saveDriver({
      id: driver.id, name: driver.name || cur?.name || "", vehicle: driver.vehicle ?? cur?.vehicle ?? null,
      lat: driver.lat ?? cur?.lat ?? null, lng: driver.lng ?? cur?.lng ?? null, heading: driver.heading ?? cur?.heading ?? null,
      status, rideId: null, reservedUntil: null, offer: null, updatedAt: Date.now(),
    });
    await this.scheduleOnce("purge:all", Date.now() + PURGE_EVERY_MS);
  }

  // ============================================================ WebSocket (hibernation API)

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const m = this.upgradeMeta(req);
    if (!m || m.role !== "driver") return new Response("bad request", { status: 400 });
    this.learnZone(m.zone);
    const { client, server } = this.acceptSocket({ userId: m.userId, role: m.role, name: m.name });

    const d: DriverRow = this.loadDriver(m.userId) ?? {
      id: m.userId, name: m.name, vehicle: null, lat: null, lng: null, heading: null,
      status: "OFFLINE", rideId: null, reservedUntil: null, offer: null, updatedAt: Date.now(),
    };
    if (m.lat !== null && m.lng !== null) {
      d.lat = m.lat;
      d.lng = m.lng;
      d.updatedAt = Date.now();
    }
    this.saveDriver(d);
    await this.scheduleOnce("purge:all", Date.now() + PURGE_EVERY_MS);
    this.sendWs(server, { t: "hello", route: matchRoute(m.zone), role: m.role, driverStatus: d.status, rideId: d.rideId });
    return new Response(null, { status: 101, webSocket: client });
  }

  protected async handle(ws: WebSocket, meta: SocketMeta, msg: ClientMsg) {
    if (meta.role !== "driver") throw new DomainError("FORBIDDEN", `${msg.t} is driver-only`);
    if (msg.t === "resume") return this.resume(ws, meta, msg.rideId);

    // the bulk of the traffic: only the columns a ping needs (no vehicle / offer JSON to parse)
    if (msg.t === "loc") {
      const p = this.loadDriverPing(meta.userId);
      if (!p) return this.handleMoved(ws, meta, msg);
      const moved = this.takePing(p, msg);
      if (moved) await this.maybeHandOff(moved);
      return;
    }

    const d = this.loadDriver(meta.userId);
    if (!d) return this.handleMoved(ws, meta, msg);

    // ride events belong to the ride's actor: pass them on (a driver who just accepted may still be here)
    if (isRideEvent(msg)) return this.forwardRideEvent(ws, meta.userId, msg);

    switch (msg.t) {
      case "online": {
        if (d.status === "ON_RIDE" || d.status === "RESERVED") return this.sendDriverState(d);
        if (d.lat === null || d.lng === null) throw new DomainError("BAD_REQUEST", "send a loc first");
        const { balance, vehicle, active } = await this.pg(async (sql) => ({
          balance: await db.getBalance(sql, d.id),
          vehicle: d.vehicle ?? (await db.getVehicle(sql, d.id)),
          active: await db.getActiveRide(sql, d.id, "driver"),
        }));
        // on a ride already (a second phone, a client that lost track): back to it, never AVAILABLE here
        if (active && this.toActiveRide(d.id, active.id)) return;
        if (balance < this.cfg.driverMinBalance) throw new DomainError("DRIVER_BALANCE_TOO_LOW", `balance ${balance}`);
        const fresh = this.loadDriver(d.id) ?? d;
        if (fresh.status !== "OFFLINE" && fresh.status !== "AVAILABLE") return this.sendDriverState(fresh);
        fresh.vehicle ??= vehicle;
        fresh.status = "AVAILABLE";
        fresh.updatedAt = Date.now();
        this.saveDriver(fresh);
        this.sendDriverState(fresh);
        await this.maybeHandOff(fresh);
        return;
      }
      case "offline": {
        const pending = d.status === "RESERVED" ? d.rideId : null;
        d.status = "OFFLINE";
        d.rideId = null;
        d.offer = null;
        d.reservedUntil = null;
        this.saveDriver(d);
        this.sendDriverState(d);
        if (pending) await this.stub(homeOfRide(pending)!).offerRejected(pending, d.id);
        return;
      }
      case "offer.accept": {
        if (d.status !== "RESERVED" || d.rideId !== msg.rideId) throw new DomainError("OFFER_EXPIRED");
        const rideHome = homeOfRide(msg.rideId);
        if (!rideHome) throw new DomainError("RIDE_NOT_FOUND");
        let res: Result<{ ride: RideView }>;
        try {
          res = await this.stub(rideHome).acceptOffer(msg.rideId, {
            id: d.id, name: d.name, vehicle: d.vehicle, lat: d.lat, lng: d.lng, heading: d.heading,
          });
        } catch (e) {
          // the call to the ride's actor failed: the accept may or may not have reached it
          console.error("accept: ride actor unreachable", msg.rideId, d.id, e);
          res = fail("UNAVAILABLE", "ride actor unreachable, retry");
        }
        if (!res.ok) {
          const cur = this.loadDriver(d.id);
          if (cur && cur.status === "RESERVED" && cur.rideId === msg.rideId) {
            if (res.code === "UNAVAILABLE") {
              // outcome unknown: the accept may still land. Hold the driver for this ride a while longer so
              // they can retry; if it landed, the ride's actor hands them over (`handOverToRide`), if not,
              // its offer timer releases them.
              cur.reservedUntil = Math.max(cur.reservedUntil ?? 0, Date.now() + this.cfg.reserveTtlMs);
            } else {
              this.setDriverFree(cur);
            }
            this.saveDriver(cur);
          }
          if (res.code === "DRIVER_BUSY") {
            // Postgres says the driver is on another ride: they are not free, here or anywhere. Take them
            // out of the search and point them at that ride (a stale AVAILABLE row heals at its first offer).
            this.sendWs(ws, { t: "error", code: res.code, message: res.message });
            const active = await this.pg((sql) => db.getActiveRide(sql, d.id, "driver")).catch((e) => {
              console.error("accept: active ride lookup failed", d.id, e);
              return null;
            });
            if (!active || !this.toActiveRide(d.id, active.id)) {
              const now = this.loadDriver(d.id);
              if (now && now.status === "AVAILABLE") {
                now.status = "OFFLINE";
                this.saveDriver(now);
                this.sendDriverState(now);
              }
            }
            return;
          }
          throw new DomainError(res.code, res.message);
        }
        // the driver lives in the ride's actor for the trip
        this.sendWs(ws, { t: "ride.status", rideId: res.ride.id, status: res.ride.status, driver: res.ride.driver, at: Date.now(), ride: res.ride });
        const cur = this.loadDriver(d.id);
        if (cur && cur.rideId === msg.rideId) this.handToRide(d.id, msg.rideId, rideHome);
        return;
      }
      case "offer.reject": {
        if (d.status !== "RESERVED" || d.rideId !== msg.rideId) return; // late / duplicate: no-op
        this.setDriverFree(d);
        this.saveDriver(d);
        this.sendDriverState(d);
        await this.stub(homeOfRide(msg.rideId)!).offerRejected(msg.rideId, d.id);
        await this.maybeHandOff(this.loadDriver(d.id) ?? d);
        return;
      }
      default:
        throw new DomainError("BAD_REQUEST", `unknown message type ${(msg as { t: string }).t}`);
    }
  }

  /**
   * A message from a socket whose driver is not here any more. Just handed to a ride's actor: the
   * client is reconnecting there, so what it sent meanwhile is passed on. Otherwise (handed to another
   * zone): ask it to reconnect without a route (the gateway places it by its active ride or location).
   */
  private async handleMoved(ws: WebSocket, meta: SocketMeta, msg: ClientMsg) {
    // mid hand-over to another zone: its `reconnect` is on the way; a ping now would only race it
    if (msg.t === "loc" && this.handingOff.has(meta.userId)) return;
    const m = this.moved.get(meta.userId);
    const rideHome = m && m.until > Date.now() ? homeOfRide(m.rideId) : null;
    if (!m || !rideHome) {
      this.sendWs(ws, { t: "reconnect", route: null });
      return ws.close(4001, "zone moved");
    }
    if (isRideEvent(msg)) return this.forwardRideEvent(ws, meta.userId, msg);
    if (msg.t === "loc") {
      await this.stub(rideHome).driverLoc(meta.userId, m.rideId, msg);
      return;
    }
    if (msg.t === "offer.accept" && msg.rideId === m.rideId) {
      const ride = await this.stub(rideHome).rideOf(msg.rideId, meta.userId);
      if (ride) this.sendWs(ws, { t: "ride.status", rideId: ride.id, status: ride.status, driver: ride.driver, at: Date.now(), ride });
      return;
    }
    this.sendWs(ws, { t: "reconnect", route: rideRoute(rideHome) });
  }

  private async forwardRideEvent(ws: WebSocket, driverId: string, msg: RideEventMsg) {
    const rz = homeOfRide(msg.rideId);
    if (!rz) throw new DomainError("RIDE_NOT_FOUND");
    const type = msg.t === "ride.arrived" ? "ARRIVE" : msg.t === "ride.start" ? "START" : "COMPLETE";
    const res = await this.stub(rz).driverRideEvent(driverId, msg.rideId, type);
    if (!res.ok) throw new DomainError(res.code, res.message);
    if (!this.moved.has(driverId)) this.sendWs(ws, { t: "reconnect", route: rideRoute(rz) });
  }

  private resume(ws: WebSocket, meta: SocketMeta, rideId?: string) {
    const d = this.loadDriver(meta.userId);
    if (d) {
      this.sendWs(ws, { t: "driver.state", status: d.status, rideId: d.rideId });
      if (d.status === "RESERVED" && d.offer && d.offer.expiresAt > Date.now()) this.sendWs(ws, { t: "offer", ...d.offer });
    }
    // a ride lives in its ride actor
    const rz = rideId ? homeOfRide(rideId) : null;
    if (rideId && rz && !(d?.status === "RESERVED" && d.rideId === rideId)) this.sendWs(ws, { t: "reconnect", route: rideRoute(rz) });
  }
}
