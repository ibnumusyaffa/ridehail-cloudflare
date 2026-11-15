import { type ErrorCode, estimate, geohashEncode, isGeohash, isValidLatLng, type PaymentMethod, type Place, type Role } from "@gojek/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { issueToken, type Principal, readToken } from "./auth";
import { homeOfRide, loadConfig, matchStub, parseRideHome, rideHome, rideStub, shardCount, shardFor } from "./config";
import * as db from "./db";
import { connect, type Sql } from "./pg";
import type { MatchApi } from "./match";
import type { RideApi } from "./ride";

export { MatchDO } from "./match";
export { RideDO } from "./ride";

type AppEnv = { Bindings: Env; Variables: { user: Principal; db: () => Sql } };

const STATUS: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RIDE_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  INSUFFICIENT_BALANCE: 402,
  DRIVER_BALANCE_TOO_LOW: 402,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

class HttpError extends Error {
  constructor(public code: ErrorCode, message: string = code) {
    super(message);
  }
}

const rideApi = (env: Env, home: string) => rideStub(env, home) as unknown as RideApi;
const matchApi = (env: Env, zone: string) => matchStub(env, zone) as unknown as MatchApi;

/** The ride actor a ride id names, only when its zone is a real zone of this deployment (no made-up actors). */
function rideHomeOf(env: Env, rideId: string): string | null {
  const home = homeOfRide(rideId);
  return home && parseRideHome(home)!.zone.length === loadConfig(env).zonePrecision ? home : null;
}

async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const b = await req.json();
    if (typeof b !== "object" || b === null) throw new Error();
    return b as T;
  } catch {
    throw new HttpError("BAD_REQUEST", "invalid json body");
  }
}

function place(v: unknown, field: string): Place {
  if (!isValidLatLng(v)) throw new HttpError("BAD_REQUEST", `${field} must be {lat, lng}`);
  const label = (v as { label?: unknown }).label;
  return { lat: v.lat, lng: v.lng, ...(typeof label === "string" ? { label: label.slice(0, 200) } : {}) };
}

const app = new Hono<AppEnv>();

// Bearer tokens only (no cookies), so any origin may call the API.
app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"], maxAge: 600 }));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, STATUS[err.code] ?? 409);
  console.error(err);
  return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
});

// One lazily-opened Postgres client per request (Hyperdrive pools the real connections).
app.use("*", async (c, next) => {
  let sql: Sql | null = null;
  c.set("db", () => (sql ??= connect(c.env)));
  try {
    await next();
  } finally {
    const open = sql as Sql | null;
    if (open) c.executionCtx.waitUntil(open.end({ timeout: 1 }).catch(() => {}));
  }
});

async function limit(limiter: RateLimit | undefined, key: string) {
  if (limiter && !(await limiter.limit({ key })).success) throw new HttpError("RATE_LIMITED", "too many requests, slow down");
}

app.get("/health", (c) => c.json({ ok: true }));

app.post("/auth/login", async (c) => {
  await limit(c.env.LOGIN_LIMITER, c.req.header("cf-connecting-ip") ?? "local");
  const b = await body<{ phone?: unknown; role?: unknown; name?: unknown }>(c.req.raw);
  const phone = typeof b.phone === "string" ? b.phone.replace(/[^\d+]/g, "") : "";
  if (phone.length < 6 || phone.length > 20) throw new HttpError("BAD_REQUEST", "phone required");
  if (b.role !== "customer" && b.role !== "driver") throw new HttpError("BAD_REQUEST", "role must be customer|driver");
  const user = await db.loginUser(c.var.db(), phone, b.role, typeof b.name === "string" ? b.name.slice(0, 80) : undefined);
  if (!user) throw new HttpError("FORBIDDEN", "phone registered with another role");
  const token = await issueToken(c.env, { sub: user.id, role: user.role, name: user.name });
  return c.json({ token, user });
});

// ------------------------------------------------------------- WebSocket gateway
// /ws?token=...  customer: &rideId=  (or active ride lookup)                         → ride:<home>
//                driver:   &rideId= (on a ride)                                       → ride:<home>
//                          &zone= (after zone.moved) | &lat=&lng= (zone by location)  → match:<zone>
//                &known=1: the client already knows whether it has an active ride (every reconnect after
//                the first hello), so the database is not consulted — a deploy's reconnect storm costs 0 queries.
app.get("/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  const user = await readToken(c.env, c.req.query("token"));
  if (!user) return c.text("unauthorized", 401);
  // Users only ever disappear through the dev reset; production trusts the signed token alone.
  if (c.env.DEV_RESET === "1" && !(await db.getUser(c.var.db(), user.sub))) return c.text("unauthorized", 401);
  if (c.env.WS_LIMITER && !(await c.env.WS_LIMITER.limit({ key: user.sub })).success) return c.text("too many reconnects", 429);
  const cfg = loadConfig(c.env);
  const q = c.req.query();
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const hasLoc = q.lat !== undefined && q.lng !== undefined && isValidLatLng({ lat, lng });

  // a ride's participants connect to its ride actor; a driver without one to the match actor of where they are
  const validZone = (z: string | null | undefined) => (z && isGeohash(z) && z.length === cfg.zonePrecision ? z : null);
  let rideHomeKey: string | null = q.rideId ? rideHomeOf(c.env, q.rideId) : null;
  if (!rideHomeKey && q.known !== "1") {
    const active = await db.getActiveRide(c.var.db(), user.sub, user.role);
    // Postgres keeps a searching ride REQUESTED; its driver is only offered it, still in a match actor
    if (active && (user.role === "customer" || active.status !== "REQUESTED")) rideHomeKey = homeOfRide(active.id);
  }
  let matchZone: string | null = null;
  if (!rideHomeKey && user.role === "driver") matchZone = validZone(q.zone) ?? (hasLoc ? geohashEncode(lat, lng, cfg.zonePrecision) : null);
  const zone = rideHomeKey ?? matchZone;
  if (!zone) return c.text(user.role === "driver" ? "lat & lng required" : "no active ride", 400);

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-zone", zone);
  headers.set("x-user-id", user.sub);
  headers.set("x-role", user.role);
  headers.set("x-user-name", encodeURIComponent(user.name));
  if (hasLoc) {
    headers.set("x-lat", String(lat));
    headers.set("x-lng", String(lng));
  }
  const stub = rideHomeKey ? rideStub(c.env, zone) : matchStub(c.env, zone);
  return stub.fetch(new Request(c.req.raw.url, { headers }));
});

// ------------------------------------------------------------- dev only
// Wipes ALL data (Postgres + every actor of every zone). Enabled only when DEV_RESET=1 (set in .dev.vars, never in prod).
app.post("/dev/reset", async (c) => {
  if (c.env.DEV_RESET !== "1") return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  // registered keys: a zone (its match actor + shard-0 ride actor) or a ride home `<zone>.<k>` (that shard)
  const keys = await db.listZones(c.var.db());
  await Promise.all(
    keys.flatMap((k) => (parseRideHome(k)?.shard ? [rideApi(c.env, k).reset()] : [matchApi(c.env, k).reset(), rideApi(c.env, k).reset()])),
  );
  await db.wipeAll(c.var.db());
  return c.json({ ok: true, zones: keys.filter((k) => !parseRideHome(k)?.shard).length });
});

// ------------------------------------------------------------- authenticated REST
app.use("*", async (c, next) => {
  const h = c.req.header("Authorization");
  const user = await readToken(c.env, h?.startsWith("Bearer ") ? h.slice(7) : null);
  if (!user) throw new HttpError("UNAUTHORIZED");
  c.set("user", user);
  await next();
});

const requireRole = (u: Principal, ...roles: Role[]) => {
  if (!roles.includes(u.role)) throw new HttpError("FORBIDDEN", `requires role ${roles.join("|")}`);
};

app.get("/me", async (c) => {
  const u = c.get("user");
  const sql = c.var.db();
  const user = await db.getUser(sql, u.sub);
  if (!user) throw new HttpError("UNAUTHORIZED");
  const [balance, vehicle] = await Promise.all([db.getBalance(sql, u.sub), u.role === "driver" ? db.getVehicle(sql, u.sub) : null]);
  return c.json({ user, vehicle, wallet: { balance } });
});

app.post("/rides/estimate", async (c) => {
  requireRole(c.get("user"), "customer");
  const b = await body(c.req.raw);
  const pickup = place(b.pickup, "pickup");
  const dropoff = place(b.dropoff, "dropoff");
  const e = estimate(pickup, dropoff, loadConfig(c.env).fare);
  return c.json({ distanceM: e.distanceM, fare: e.fare });
});

app.post("/rides", async (c) => {
  const u = c.get("user");
  requireRole(u, "customer");
  const cfg = loadConfig(c.env);
  const b = await body(c.req.raw);
  const pickup = place(b.pickup, "pickup");
  const dropoff = place(b.dropoff, "dropoff");
  const paymentMethod = (b.paymentMethod ?? "CASH") as PaymentMethod;
  if (paymentMethod !== "CASH" && paymentMethod !== "WALLET") throw new HttpError("BAD_REQUEST", "paymentMethod must be CASH|WALLET");
  const idemKey = c.req.header("Idempotency-Key")?.slice(0, 100) ?? null;
  // Idempotency, one-active-ride and the wallet hold are enforced by Postgres inside createRide.
  // A busy zone's rides are spread over its ride shards, by customer (a retry lands on the same one).
  const zone = geohashEncode(pickup.lat, pickup.lng, cfg.zonePrecision);
  const home = rideHome(zone, shardFor(u.sub, shardCount(cfg, zone)));
  const res = await rideApi(c.env, home).createRide(home, { customerId: u.sub, pickup, dropoff, paymentMethod, idempotencyKey: idemKey });
  if (!res.ok) throw new HttpError(res.code, res.message);
  return c.json({ rideId: res.ride.id, status: res.ride.status, ride: res.ride }, 201);
});

app.get("/rides", async (c) => {
  const u = c.get("user");
  if (c.req.query("active") === "1") {
    const ride = await db.getActiveRide(c.var.db(), u.sub, u.role);
    return c.json({ ride });
  }
  const sql = c.var.db();
  const rides = await db.listRides(sql, u.sub, u.role);
  if (u.role === "driver") {
    const startOfDay = new Date();
    startOfDay.setUTCHours(-7, 0, 0, 0); // WIB midnight (UTC+7)
    if (startOfDay.getTime() > Date.now()) startOfDay.setUTCDate(startOfDay.getUTCDate() - 1);
    const today = await db.driverEarnings(sql, u.sub, startOfDay.getTime(), loadConfig(c.env).commissionRate);
    return c.json({ rides, today });
  }
  return c.json({ rides });
});

app.get("/rides/:id", async (c) => {
  const u = c.get("user");
  const ride = await db.getRide(c.var.db(), c.req.param("id"));
  if (!ride) throw new HttpError("RIDE_NOT_FOUND");
  if (ride.customerId !== u.sub && ride.driverId !== u.sub) throw new HttpError("FORBIDDEN");
  return c.json({ ride });
});

app.post("/rides/:id/cancel", async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const home = rideHomeOf(c.env, id);
  if (!home) throw new HttpError("RIDE_NOT_FOUND");
  const b = await body<{ reason?: unknown }>(c.req.raw).catch(() => ({}) as { reason?: unknown });
  const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : "";
  if (u.role === "driver" && !reason) throw new HttpError("BAD_REQUEST", "driver must give a reason");
  const res = await rideApi(c.env, home).cancelRide(id, u.sub, u.role, reason);
  if (!res.ok) throw new HttpError(res.code, res.message);
  return c.json({ ride: res.ride });
});

// ON_TRIP with the driver gone silent: the customer says how it ended ("arrived" pays, "cancel" releases).
app.post("/rides/:id/driver-lost", async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const home = rideHomeOf(c.env, id);
  if (!home) throw new HttpError("RIDE_NOT_FOUND");
  if (u.role !== "customer") throw new HttpError("FORBIDDEN");
  const { action } = await body<{ action?: unknown }>(c.req.raw);
  if (action !== "arrived" && action !== "cancel") throw new HttpError("BAD_REQUEST", "action must be arrived | cancel");
  const res = await rideApi(c.env, home).driverLost(id, u.sub, action);
  if (!res.ok) throw new HttpError(res.code, res.message);
  return c.json({ ride: res.ride });
});

app.post("/rides/:id/rating", async (c) => {
  const u = c.get("user");
  requireRole(u, "customer");
  const b = await body<{ stars?: unknown }>(c.req.raw);
  const stars = b.stars;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError("BAD_REQUEST", "stars 1..5");
  if (!(await db.rateRide(c.var.db(), c.req.param("id"), u.sub, stars)))
    throw new HttpError("INVALID_TRANSITION", "ride not completed, not yours, or already rated");
  return c.json({ ok: true });
});

app.get("/wallet", async (c) => c.json(await db.getWallet(c.var.db(), c.get("user").sub)));

app.post("/wallet/topup", async (c) => {
  const u = c.get("user");
  const cfg = loadConfig(c.env);
  const idemKey = c.req.header("Idempotency-Key")?.slice(0, 100);
  if (!idemKey) throw new HttpError("BAD_REQUEST", "Idempotency-Key header required");
  const b = await body<{ amount?: unknown }>(c.req.raw);
  const amount = b.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > cfg.topupMax)
    throw new HttpError("BAD_REQUEST", `amount must be an integer in 1..${cfg.topupMax}`);
  return c.json({ balance: await db.topup(c.var.db(), u.sub, amount, idemKey) });
});

app.get("/wallet/transactions", async (c) => c.json({ transactions: await db.listTransactions(c.var.db(), c.get("user").sub) }));

export default app;
