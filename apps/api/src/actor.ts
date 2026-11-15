import { DurableObject } from "cloudflare:workers";
import { acceptPing, DomainError, type DriverStatus, geohashEncode, isValidLatLng, type Role } from "@gojek/core";
import { type Config, keyOfActor, loadConfig, zoneOfKey } from "./config";
import * as db from "./db";
import { type Sql, withDb } from "./pg";
import type { ClientMsg, OfferPayload, ServerMsg, Vehicle } from "./protocol";

export interface DriverRow {
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

export interface SocketMeta {
  userId: string;
  role: Role;
  name: string;
}

export const PURGE_EVERY_MS = 10 * 60_000;
export const SNAPSHOT_MS = 30_000;
const ALARM_CONCURRENCY = 16;

/** Backoff for retries (Postgres, RPC to another actor): 2 s, 4 s, … capped at 60 s. */
export const retryDelay = (attempt: number) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));

/** Run `fn` over `items` with at most `limit` in flight. */
async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * What both actors of a zone share: config, the zone name, SQLite timers multiplexed on the DO alarm,
 * sockets, the Postgres seam, and driver rows with their live positions (memory + geohash grid).
 *
 * A zone has a match actor `match:<zone>` (see `MatchDO`) and one or more ride actors `ride:<home>`
 * (see `RideDO`; home = the zone, or `<zone>.<k>` for shard k of a busy zone).
 */
export abstract class ZoneActor extends DurableObject<Env> {
  protected cfg: Config;
  protected sql: SqlStorage;
  /** this actor's key: the zone (match actor) or the ride home `<zone>[.<k>]` (ride actor) */
  protected key: string | null;
  /** the geohash zone this actor serves (its key without a shard) */
  protected zone: string | null;
  protected registered: boolean;
  protected pos = new Map<string, Pos>();
  protected grid = new Map<string, Set<string>>();
  protected gridPrecision: number;
  /** cached alarm time: undefined = unknown (read lazily), null = none set */
  protected nextAlarm: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = loadConfig(env);
    this.sql = ctx.storage.sql;
    this.gridPrecision = Math.max(...this.cfg.match.ringPrecisions);
    this.initSchema();
    this.key = keyOfActor(ctx.id.name) ?? this.meta("zone");
    this.zone = this.key ? zoneOfKey(this.key) : null;
    this.registered = this.meta("registered") === "1";
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    this.loadPositions();
    void ctx.blockConcurrencyWhile(() => this.rearmTimers());
  }

  /** Tables of this kind of actor (the shared ones are created by `initSchema`). */
  protected abstract initTables(): void;
  /** A due timer `<kind>:<id>`. */
  protected abstract onTimer(kind: string, id: string): Promise<void>;
  /** A message from a client socket (pings are answered without waking the actor). */
  protected abstract handle(ws: WebSocket, meta: SocketMeta, msg: ClientMsg): Promise<void>;

  protected initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT,
        lat REAL, lng REAL, heading REAL, cell TEXT,
        status TEXT NOT NULL, ride_id TEXT, reserved_until INTEGER, offer TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drivers_cell ON drivers (cell);
      CREATE TABLE IF NOT EXISTS timers (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this.initTables();
  }

  protected meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  /**
   * On every start the alarm must be set for the earliest timer (a crash between writing a timer row
   * and setting the alarm must not leave work nothing picks up). Subclasses add the timers their
   * pending work needs first, then call this.
   */
  protected async rearmTimers() {
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

  // ============================================================ helpers

  /** Remember this actor's key (zone, or ride home) when its name was not available. */
  protected learnZone(key: string | null) {
    if (!key) return;
    if (this.key !== key) {
      this.key = key;
      this.zone = zoneOfKey(key);
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('zone', ?)", key);
    }
    if (!this.registered) {
      // record this actor's key in Postgres once, so every actor can be enumerated (ops, dev reset)
      this.registered = true;
      void this.pg((sql) => db.registerZone(sql, key)).then(
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
    this.key = keyOfActor(this.ctx.id.name);
    this.zone = this.key ? zoneOfKey(this.key) : null;
    this.registered = false;
    this.pos.clear();
    this.grid.clear();
    this.nextAlarm = null;
  }

  /** Every Postgres call of this actor goes through here (one seam; tests simulate outages with it). */
  protected pg<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return withDb(this.env, fn);
  }

  protected zoneOf(lat: number, lng: number) {
    return geohashEncode(lat, lng, this.cfg.zonePrecision);
  }

  protected send(userId: string, msg: ServerMsg): number {
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

  protected sendWs(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }

  protected connected(userId: string) {
    return this.ctx.getWebSockets(`user:${userId}`).length > 0;
  }

  /** Tell every socket of `userId` to reconnect elsewhere; `close` also closes them (the client reconnects). */
  protected moveSockets(userId: string, msg: Extract<ServerMsg, { t: "zone.moved" }>, close: boolean) {
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      this.sendWs(ws, msg);
      if (!close) continue;
      try {
        ws.close(4001, "zone moved");
      } catch {
        /* already closing */
      }
    }
  }

  // ------------------------------------------------------------ timers (DO alarm multiplexed)

  protected async schedule(key: string, at: number) {
    this.sql.exec("INSERT OR REPLACE INTO timers (key, at) VALUES (?, ?)", key, at);
    if (this.nextAlarm === undefined) this.nextAlarm = await this.ctx.storage.getAlarm();
    if (this.nextAlarm === null || at < this.nextAlarm) {
      this.nextAlarm = at;
      await this.ctx.storage.setAlarm(at);
    }
  }

  /** Schedule `key` unless it is already scheduled (keeps the earlier time). */
  protected async scheduleOnce(key: string, at: number) {
    const has = this.sql.exec("SELECT 1 FROM timers WHERE key = ?", key).toArray().length > 0;
    if (!has) await this.schedule(key, at);
  }

  protected cancelTimer(key: string) {
    this.sql.exec("DELETE FROM timers WHERE key = ?", key);
  }

  /**
   * Fires every due timer. Timers of different ids run concurrently (bounded), timers of the same
   * id run in order — so one slow RPC / database call doesn't delay every other ride.
   */
  async alarm() {
    this.nextAlarm = null; // the alarm that fired is consumed
    const now = Date.now();
    const due = this.sql.exec<{ key: string }>("SELECT key FROM timers WHERE at <= ? ORDER BY at", now).toArray();
    const byId = new Map<string, string[]>();
    for (const { key } of due) {
      const id = key.slice(key.indexOf(":") + 1);
      byId.set(id, [...(byId.get(id) ?? []), key]);
    }
    await runLimited([...byId.values()], ALARM_CONCURRENCY, async (keys) => {
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
    const i = key.indexOf(":");
    try {
      await this.onTimer(key.slice(0, i), key.slice(i + 1));
    } catch (err) {
      console.error("timer failed", key, err);
    }
  }

  // ------------------------------------------------------------ driver positions (memory + grid)

  protected setPos(id: string, lat: number, lng: number, heading: number | null, ts: number, savedAt?: number) {
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

  protected removeDriver(id: string) {
    this.sql.exec("DELETE FROM drivers WHERE id = ?", id);
    this.dropPos(id);
  }

  // ------------------------------------------------------------ hot store: drivers

  /** Driver row from SQLite with the live in-memory position laid over it. */
  protected loadDriver(id: string): DriverRow | null {
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
  protected saveDriver(d: DriverRow) {
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

  protected setDriverFree(d: DriverRow) {
    d.status = "AVAILABLE";
    d.rideId = null;
    d.reservedUntil = null;
    d.offer = null;
  }

  protected sendDriverState(d: DriverRow) {
    this.send(d.id, { t: "driver.state", status: d.status, rideId: d.rideId });
  }

  /**
   * Take a location ping into memory (throttled). Returns the driver row, updated, or null when the
   * ping was dropped. SQLite only gets a snapshot every SNAPSHOT_MS.
   */
  protected takePing(d: DriverRow, msg: { lat: number; lng: number; heading?: number }): DriverRow | null {
    if (!isValidLatLng(msg)) throw new DomainError("BAD_REQUEST", "invalid lat/lng");
    const now = Date.now();
    const prev = this.pos.get(d.id);
    const last = prev ? { lat: prev.lat, lng: prev.lng, at: prev.ts } : null;
    if (!acceptPing(last, { lat: msg.lat, lng: msg.lng, at: now }, d.status === "ON_RIDE", this.cfg.presence)) return null;
    d.lat = msg.lat;
    d.lng = msg.lng;
    d.heading = typeof msg.heading === "number" ? msg.heading : d.heading;
    d.updatedAt = now;
    this.setPos(d.id, d.lat, d.lng, d.heading, now);
    if (now - (this.pos.get(d.id)?.savedAt ?? 0) >= SNAPSHOT_MS) this.saveDriver(d);
    return d;
  }

  // ============================================================ WebSocket (hibernation API)

  /**
   * Location pings are the bulk of all traffic: drop the ones the throttle would drop anyway from
   * memory alone, before touching SQLite. Checked with the looser of the two intervals, so a ping
   * dropped here would also be dropped later whatever the driver's status turns out to be.
   */
  protected throttled(userId: string, msg: ClientMsg): boolean {
    if (msg.t !== "loc" || !isValidLatLng(msg)) return false;
    const prev = this.pos.get(userId);
    if (!prev) return false;
    const { locMinIntervalMs, locMinIntervalOnRideMs } = this.cfg.presence;
    const loosest = locMinIntervalOnRideMs <= locMinIntervalMs;
    return !acceptPing({ lat: prev.lat, lng: prev.lng, at: prev.ts }, { lat: msg.lat, lng: msg.lng, at: Date.now() }, loosest, this.cfg.presence);
  }

  /** Accept a hibernatable socket for `userId` (replacing any older one on this actor). */
  protected acceptSocket(meta: SocketMeta): { client: WebSocket; server: WebSocket } {
    for (const old of this.ctx.getWebSockets(`user:${meta.userId}`)) old.close(4000, "replaced");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`user:${meta.userId}`]);
    server.serializeAttachment(meta satisfies SocketMeta);
    return { client, server };
  }

  /** The gateway's headers on a WebSocket upgrade. */
  protected upgradeMeta(req: Request): (SocketMeta & { zone: string; lat: number | null; lng: number | null }) | null {
    const zone = req.headers.get("x-zone");
    const userId = req.headers.get("x-user-id");
    const role = req.headers.get("x-role") as Role | null;
    const name = decodeURIComponent(req.headers.get("x-user-name") ?? "");
    if (!zone || !userId || !role) return null;
    const lat = Number(req.headers.get("x-lat"));
    const lng = Number(req.headers.get("x-lng"));
    const hasLoc = req.headers.has("x-lat") && isValidLatLng({ lat, lng });
    return { zone, userId, role, name, lat: hasLoc ? lat : null, lng: hasLoc ? lng : null };
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
      if (msg.t === "ping") return this.sendWs(ws, { t: "pong" });
      if (this.throttled(meta.userId, msg)) return;
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
}
