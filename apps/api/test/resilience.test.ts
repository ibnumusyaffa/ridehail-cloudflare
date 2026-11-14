import { env, runInDurableObject } from "cloudflare:test";
import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import { api, Client, login, onlineDriver, sleep, status, withSql } from "./helpers";

// Postgres outages are simulated per zone actor by shadowing its `pg` seam (every DB call of ZoneDO
// goes through it); the test's own queries (withSql) still reach the real database.

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-7.2 - area * 0.1, 107.5 + area * 0.07, 5));
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const zoneOf = (p: { lat: number; lng: number }) => geohashEncode(p.lat, p.lng, 5);

type Outage = "off" | "down" | "lost-reply";

/** "down": every query fails. "lost-reply": the query commits, then the caller sees an error. */
async function postgres(zone: string, mode: Outage) {
  const ns = (env as unknown as { ZONE: DurableObjectNamespace }).ZONE;
  // loosely typed on purpose: inferring ZoneDO's RPC types here exceeds tsc's depth limit
  const run = runInDurableObject as unknown as (stub: unknown, fn: (inst: any) => void) => Promise<void>;
  await run(ns.get(ns.idFromName(zone)), (inst) => {
    delete inst.pg; // back to the prototype's real implementation
    if (mode === "off") return;
    const real = inst.pg.bind(inst);
    inst.pg =
      mode === "down"
        ? () => Promise.reject(new Error("simulated Postgres outage"))
        : async (fn: unknown) => {
            await real(fn);
            throw new Error("simulated lost reply");
          };
  });
}

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > until) return v;
    await sleep(250);
  }
}

async function customer(balance = 0) {
  const c = await login("customer", "Rina");
  if (balance) await api("/wallet/topup", { token: c.token, body: { amount: balance }, headers: { "Idempotency-Key": "init" } });
  return c;
}

const order = (token: string, p: { lat: number; lng: number }, paymentMethod = "CASH", key?: string) =>
  api("/rides", {
    token,
    body: { pickup: p, dropoff: off(p, 0.03, 0.02), paymentMethod },
    headers: key ? { "Idempotency-Key": key } : {},
  });

describe("Postgres outages", () => {
  it("cancel during an outage: the zone cancels, the outbox retries, hold released and customer unlocked", async () => {
    const p = spot();
    const c = await customer(50_000);
    const created = await order(c.token, p, "WALLET");
    expect(created.status).toBe(201);
    const rideId: string = created.json.rideId;
    expect((await api("/wallet", { token: c.token })).json.held).toBe(created.json.ride.fare);

    await postgres(zoneOf(p), "down");
    const cancelled = await api(`/rides/${rideId}/cancel`, { token: c.token, body: { reason: "changed plans" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.ride.status).toBe("CANCELLED");
    // Postgres has not heard of it yet
    expect((await withSql(env as unknown as Env, (sql) => db.getRide(sql, rideId)))?.status).toBe("REQUESTED");

    await postgres(zoneOf(p), "off");
    const ride = await eventually(
      () => withSql(env as unknown as Env, (sql) => db.getRide(sql, rideId)),
      (r) => r?.status === "CANCELLED",
    );
    expect(ride?.status).toBe("CANCELLED");
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    expect((await order(c.token, p)).status).toBe(201);
  });

  it("settlement fails: driver is freed at once, settlement is retried until paid", async () => {
    const p = spot();
    const c = await customer(100_000);
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Joko");
    const created = await order(c.token, p, "WALLET");
    const rideId: string = created.json.rideId;
    const fare: number = created.json.ride.fare;
    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");

    await drv.ws.next("offer");
    drv.ws.send({ t: "offer.accept", rideId });
    await cws.next(status("ACCEPTED"));
    drv.ws.send({ t: "ride.arrived", rideId });
    await cws.next(status("ARRIVED"));
    drv.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));

    await postgres(zoneOf(p), "down");
    drv.ws.send({ t: "ride.complete", rideId });
    await cws.next(status("COMPLETED"));
    // not stuck ON_RIDE although nothing could be paid
    expect((await drv.ws.next((m) => m.t === "driver.state" && m.status === "AVAILABLE")).rideId).toBeNull();
    drv.ws.send({ t: "ride.complete", rideId }); // repeated complete during the outage: no crash, still unpaid
    await sleep(300);
    expect(cws.inbox.some((m) => m.t === "ride.paid")).toBe(false);

    await postgres(zoneOf(p), "off");
    const paid = await cws.next("ride.paid", 15_000);
    expect(paid.paidVia).toBe("WALLET");
    expect(paid.balance).toBe(100_000 - fare);
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 100_000 - fare, held: 0 });
    const ride = await eventually(
      () => withSql(env as unknown as Env, (sql) => db.getRide(sql, rideId)),
      (r) => r?.status === "COMPLETED",
    );
    expect(ride?.status).toBe("COMPLETED");
    cws.close();
    drv.ws.close();
  });

  it("create: Postgres commits but the reply is lost → the zone recovers the ride and dispatches it", async () => {
    const p = spot();
    const c = await customer();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Sari");

    await postgres(zoneOf(p), "lost-reply");
    expect((await order(c.token, p, "CASH", "k-lost")).status).toBe(503);
    await postgres(zoneOf(p), "off");

    // the recovery timer finds the committed row and starts dispatch on its own
    const offer = await drv.ws.next("offer", 15_000);
    const again = await order(c.token, p, "CASH", "k-lost");
    expect(again.status).toBe(201);
    expect(again.json.rideId).toBe(offer.rideId);
    drv.ws.close();
  });

  it("create: Postgres down before commit → the pending ride is dropped and a retry creates it", async () => {
    const p = spot();
    const c = await customer();

    await postgres(zoneOf(p), "down");
    expect((await order(c.token, p, "CASH", "k-down")).status).toBe(503);
    await postgres(zoneOf(p), "off");

    const again = await order(c.token, p, "CASH", "k-down");
    expect(again.status).toBe(201);
    const pg = await withSql(env as unknown as Env, (sql) => db.getActiveRide(sql, c.id, "customer"));
    expect(pg?.id).toBe(again.json.rideId);
  });
});
