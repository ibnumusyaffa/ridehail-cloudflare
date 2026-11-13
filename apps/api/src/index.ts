import { type ErrorCode, estimate, geohashEncode, isGeohash, isValidLatLng, type PaymentMethod, type Place, type Role } from "@gojek/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { issueToken, type Principal, readToken } from "./auth";
import { loadConfig, zoneOfRide } from "./config";
import * as db from "./db";
import type { ZoneApi } from "./zone";

export { ZoneDO } from "./zone";

type AppEnv = { Bindings: Env; Variables: { user: Principal } };

const STATUS: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RIDE_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  INSUFFICIENT_BALANCE: 402,
  DRIVER_BALANCE_TOO_LOW: 402,
};

class HttpError extends Error {
  constructor(public code: ErrorCode, message: string = code) {
    super(message);
  }
}

const zoneStub = (env: Env, zone: string) => env.ZONE.get(env.ZONE.idFromName(zone)) as unknown as ZoneApi;

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

app.get("/health", (c) => c.json({ ok: true }));

app.post("/auth/login", async (c) => {
  const b = await body<{ phone?: unknown; role?: unknown; name?: unknown }>(c.req.raw);
  const phone = typeof b.phone === "string" ? b.phone.replace(/[^\d+]/g, "") : "";
  if (phone.length < 6 || phone.length > 20) throw new HttpError("BAD_REQUEST", "phone required");
  if (b.role !== "customer" && b.role !== "driver") throw new HttpError("BAD_REQUEST", "role must be customer|driver");
  const user = await db.loginUser(c.env.DB, phone, b.role, typeof b.name === "string" ? b.name.slice(0, 80) : undefined);
  if (!user) throw new HttpError("FORBIDDEN", "phone registered with another role");
  const token = await issueToken(c.env, { sub: user.id, role: user.role, name: user.name });
  return c.json({ token, user });
});

// ------------------------------------------------------------- WebSocket gateway
// /ws?token=...  customer: &rideId=  (or active ride lookup)
//                driver:   &lat=&lng= (zone by location) | &zone= (explicit, after zone.moved) | active ride
app.get("/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  const user = await readToken(c.env, c.req.query("token"));
  if (!user || !(await db.getUser(c.env.DB, user.sub))) return c.text("unauthorized", 401);
  const cfg = loadConfig(c.env);
  const q = c.req.query();
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const hasLoc = q.lat !== undefined && q.lng !== undefined && isValidLatLng({ lat, lng });

  let zone: string | null = null;
  if (q.rideId) zone = zoneOfRide(q.rideId);
  if (!zone && q.zone && isGeohash(q.zone) && q.zone.length === cfg.zonePrecision) zone = q.zone;
  if (!zone) {
    const active = await db.getActiveRide(c.env.DB, user.sub, user.role);
    if (active && (user.role === "customer" || active.status !== "OFFERING")) zone = zoneOfRide(active.id);
  }
  if (!zone && hasLoc) zone = geohashEncode(lat, lng, cfg.zonePrecision);
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
  const stub = c.env.ZONE.get(c.env.ZONE.idFromName(zone));
  return stub.fetch(new Request(c.req.raw.url, { headers }));
});

// ------------------------------------------------------------- dev only
// Wipes ALL data (D1 + every zone actor). Enabled only when DEV_RESET=1 (set in .dev.vars, never in prod).
app.post("/dev/reset", async (c) => {
  if (c.env.DEV_RESET !== "1") return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  const { results } = await c.env.DB.prepare("SELECT zone FROM zones").all<{ zone: string }>();
  await Promise.all(results.map((z) => zoneStub(c.env, z.zone).reset()));
  await c.env.DB.batch(
    ["wallet_transactions", "wallets", "rides", "vehicles", "users", "zones"].map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)),
  );
  return c.json({ ok: true, zones: results.length });
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
  const user = await db.getUser(c.env.DB, u.sub);
  if (!user) throw new HttpError("UNAUTHORIZED");
  const [balance, vehicle] = await Promise.all([
    db.getBalance(c.env.DB, u.sub),
    u.role === "driver" ? db.getVehicle(c.env.DB, u.sub) : null,
  ]);
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

  if (idemKey) {
    const prev = await db.getRideByIdempotencyKey(c.env.DB, u.sub, idemKey);
    if (prev) return c.json({ rideId: prev.id, status: prev.status, ride: prev });
  }
  const active = await db.getActiveRide(c.env.DB, u.sub, "customer");
  if (active) throw new HttpError("ACTIVE_RIDE_EXISTS", `active ride ${active.id}`);
  if (paymentMethod === "WALLET") {
    const { fare } = estimate(pickup, dropoff, cfg.fare);
    const balance = await db.getBalance(c.env.DB, u.sub);
    if (balance < fare) throw new HttpError("INSUFFICIENT_BALANCE", `balance ${balance} < fare ${fare}`);
  }
  const zone = geohashEncode(pickup.lat, pickup.lng, cfg.zonePrecision);
  const res = await zoneStub(c.env, zone).createRide(zone, { customerId: u.sub, pickup, dropoff, paymentMethod, idempotencyKey: idemKey });
  if (!res.ok) throw new HttpError(res.code, res.message);
  return c.json({ rideId: res.ride.id, status: res.ride.status, ride: res.ride }, 201);
});

app.get("/rides", async (c) => {
  const u = c.get("user");
  if (c.req.query("active") === "1") {
    const ride = await db.getActiveRide(c.env.DB, u.sub, u.role);
    return c.json({ ride });
  }
  const rides = await db.listRides(c.env.DB, u.sub, u.role);
  if (u.role === "driver") {
    const startOfDay = new Date();
    startOfDay.setUTCHours(-7, 0, 0, 0); // WIB midnight (UTC+7)
    if (startOfDay.getTime() > Date.now()) startOfDay.setUTCDate(startOfDay.getUTCDate() - 1);
    const today = rides.filter((r) => r.status === "COMPLETED" && (r.completedAt ?? 0) >= startOfDay.getTime());
    const commission = loadConfig(c.env).commissionRate;
    return c.json({
      rides,
      today: {
        count: today.length,
        gross: today.reduce((s, r) => s + (r.fareFinal ?? r.fare), 0),
        net: today.reduce((s, r) => s + Math.round((r.fareFinal ?? r.fare) * (1 - commission)), 0),
      },
    });
  }
  return c.json({ rides });
});

app.get("/rides/:id", async (c) => {
  const u = c.get("user");
  const ride = await db.getRide(c.env.DB, c.req.param("id"));
  if (!ride) throw new HttpError("RIDE_NOT_FOUND");
  if (ride.customerId !== u.sub && ride.driverId !== u.sub) throw new HttpError("FORBIDDEN");
  return c.json({ ride });
});

app.post("/rides/:id/cancel", async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const zone = zoneOfRide(id);
  if (!zone) throw new HttpError("RIDE_NOT_FOUND");
  const b = await body<{ reason?: unknown }>(c.req.raw).catch(() => ({}) as { reason?: unknown });
  const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : "";
  if (u.role === "driver" && !reason) throw new HttpError("BAD_REQUEST", "driver must give a reason");
  const res = await zoneStub(c.env, zone).cancelRide(id, u.sub, u.role, reason);
  if (!res.ok) throw new HttpError(res.code, res.message);
  return c.json({ ride: res.ride });
});

app.post("/rides/:id/rating", async (c) => {
  const u = c.get("user");
  requireRole(u, "customer");
  const b = await body<{ stars?: unknown }>(c.req.raw);
  const stars = b.stars;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError("BAD_REQUEST", "stars 1..5");
  if (!(await db.rateRide(c.env.DB, c.req.param("id"), u.sub, stars)))
    throw new HttpError("INVALID_TRANSITION", "ride not completed, not yours, or already rated");
  return c.json({ ok: true });
});

app.get("/wallet", async (c) => c.json({ balance: await db.getBalance(c.env.DB, c.get("user").sub) }));

app.post("/wallet/topup", async (c) => {
  const u = c.get("user");
  const cfg = loadConfig(c.env);
  const idemKey = c.req.header("Idempotency-Key")?.slice(0, 100);
  if (!idemKey) throw new HttpError("BAD_REQUEST", "Idempotency-Key header required");
  const b = await body<{ amount?: unknown }>(c.req.raw);
  const amount = b.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > cfg.topupMax)
    throw new HttpError("BAD_REQUEST", `amount must be an integer in 1..${cfg.topupMax}`);
  return c.json({ balance: await db.topup(c.env.DB, u.sub, amount, idemKey) });
});

app.get("/wallet/transactions", async (c) => c.json({ transactions: await db.listTransactions(c.env.DB, c.get("user").sub) }));

export default app;
