import { env, runInDurableObject } from "cloudflare:test";
import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import { api, Client, login, onlineDriver, sleep, status, withSql } from "./helpers";

// A driver who drops an accepted ride does not end it: the ride goes back to the search, the driver
// is never offered it again, and the customer keeps the order (and its wallet hold).

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-7.9 - area * 0.1, 112.6 + area * 0.07, 5));
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const zoneOf = (p: { lat: number; lng: number }) => geohashEncode(p.lat, p.lng, 5);

/** Run `fn` on the zone actor's instance (loosely typed: ZoneDO's RPC types exceed tsc's depth limit). */
async function inZone(zone: string, fn: (inst: any) => void) {
  const ns = (env as unknown as { ZONE: DurableObjectNamespace }).ZONE;
  const run = runInDurableObject as unknown as (stub: unknown, fn: (inst: any) => void) => Promise<void>;
  await run(ns.get(ns.idFromName(zone)), fn);
}

/** "down": every query fails. "lost-reply": the query commits, then the caller sees an error. */
const postgres = (zone: string, mode: "off" | "down" | "lost-reply") =>
  inZone(zone, (inst) => {
    delete inst.pg;
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

const pgRide = (id: string) => withSql(env as unknown as Env, (sql) => db.getRide(sql, id));

/** A WALLET order the given driver has accepted; the customer's socket is open. */
async function accepted(p: { lat: number; lng: number }, drv: Awaited<ReturnType<typeof onlineDriver>>) {
  const c = await login("customer", "Sari");
  await api("/wallet/topup", { token: c.token, body: { amount: 100_000 }, headers: { "Idempotency-Key": "init" } });
  const res = await api("/rides", { token: c.token, body: { pickup: p, dropoff: off(p, 0.03, 0.02), paymentMethod: "WALLET" } });
  expect(res.status).toBe(201);
  const rideId: string = res.json.rideId;
  const fare: number = res.json.ride.fare;
  const cws = await Client.connect({ token: c.token, rideId });
  await cws.next("hello");
  expect((await drv.ws.next("offer")).rideId).toBe(rideId);
  drv.ws.send({ t: "offer.accept", rideId });
  await cws.next(status("ACCEPTED"));
  return { c, rideId, fare, cws };
}

const dropRide = (rideId: string, token: string) => api(`/rides/${rideId}/cancel`, { token, body: { reason: "ban bocor" } });

describe("driver drops an accepted ride", () => {
  it("ACCEPTED → the ride is searched again, another driver gets it, the hold stays", async () => {
    const p = spot();
    const first = await onlineDriver(off(p, 0.001).lat, p.lng, "Batal");
    const second = await onlineDriver(off(p, 0.004).lat, p.lng, "Kedua");
    const { c, rideId, fare, cws } = await accepted(p, first);

    const res = await dropRide(rideId, first.token);
    expect(res.status).toBe(200);
    expect(res.json.ride).toMatchObject({ status: "REQUESTED", driverId: null, driver: null, acceptedAt: null, cancelledBy: null });

    expect(await cws.next("ride.requeued")).toMatchObject({ rideId, reason: "DRIVER_CANCELLED" });
    const back = await cws.next(status("REQUESTED"));
    expect(back.ride.driverId).toBeNull();
    expect((await first.ws.next((m) => m.t === "driver.state")).status).toBe("AVAILABLE");

    // Postgres: searching again, no driver on the row, the customer's hold is untouched
    expect(await pgRide(rideId)).toMatchObject({ status: "REQUESTED", driverId: null, acceptedAt: null });
    expect((await api("/wallet", { token: c.token })).json.held).toBe(fare);
    // the dropped driver no longer sees the ride; a retry of the drop is still OK (reply may have been lost)
    expect((await api(`/rides/${rideId}`, { token: first.token })).status).toBe(403);
    expect((await dropRide(rideId, first.token)).status).toBe(200);

    // the nearer driver who dropped it is skipped: the other one is offered
    expect((await second.ws.next("offer")).rideId).toBe(rideId);
    second.ws.send({ t: "offer.accept", rideId });
    expect((await cws.next(status("ACCEPTED"))).driver.name).toBe("Kedua");
    expect(first.ws.inbox.some((m) => m.t === "offer")).toBe(false);
    expect(await pgRide(rideId)).toMatchObject({ status: "ACCEPTED", driverId: second.id });

    // the dropped driver is free for other orders
    const c2 = await login("customer", "Lain");
    const r2 = await api("/rides", { token: c2.token, body: { pickup: p, dropoff: off(p, 0.02), paymentMethod: "CASH" } });
    expect((await first.ws.next("offer")).rideId).toBe(r2.json.rideId);
    for (const w of [cws, first.ws, second.ws]) w.close();
  });

  it("ARRIVED, nobody else around → a fresh search, never the same driver, then NO_DRIVER", async () => {
    const p = spot();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Sendiri");
    const { c, rideId, cws } = await accepted(p, drv);
    drv.ws.send({ t: "ride.arrived", rideId });
    await cws.next(status("ARRIVED"));

    const dropped = Date.now();
    expect((await dropRide(rideId, drv.token)).json.ride.status).toBe("REQUESTED");
    await cws.next(status("REQUESTED"));
    // the search deadline starts over (SEARCH_TIMEOUT_MS = 3 s in tests)
    await cws.next(status("NO_DRIVER"), 8_000);
    expect(Date.now() - dropped).toBeGreaterThanOrEqual(2_500);
    expect(drv.ws.inbox.some((m) => m.t === "offer")).toBe(false);
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    for (const w of [cws, drv.ws]) w.close();
  });

  it("dropped more than maxRequeues times → the system cancels the ride, the hold is released", async () => {
    const p = spot();
    await inZone(zoneOf(p), (inst) => {
      inst.cfg.maxRequeues = 1;
    });
    const first = await onlineDriver(off(p, 0.001).lat, p.lng, "Satu");
    const second = await onlineDriver(off(p, 0.003).lat, p.lng, "Dua");
    const { c, rideId, cws } = await accepted(p, first);

    expect((await dropRide(rideId, first.token)).json.ride.status).toBe("REQUESTED");
    expect((await second.ws.next("offer")).rideId).toBe(rideId);
    second.ws.send({ t: "offer.accept", rideId });
    await cws.next(status("ACCEPTED"));

    const res = await dropRide(rideId, second.token);
    expect(res.status).toBe(200);
    expect(res.json.ride).toMatchObject({ status: "CANCELLED", cancelledBy: "system", cancelReason: "drivers_cancelled" });
    await cws.next(status("CANCELLED"));
    expect((await second.ws.next((m) => m.t === "driver.state")).status).toBe("AVAILABLE");
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    await inZone(zoneOf(p), (inst) => {
      inst.cfg.maxRequeues = 3;
    });
    for (const w of [cws, first.ws, second.ws]) w.close();
  });

  it("customer cancels while the ride is searched again → CANCELLED, hold released", async () => {
    const p = spot();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Pergi");
    const { c, rideId, cws } = await accepted(p, drv);
    await dropRide(rideId, drv.token);
    await cws.next(status("REQUESTED"));

    const res = await api(`/rides/${rideId}/cancel`, { token: c.token, body: { reason: "kelamaan" } });
    expect(res.json.ride).toMatchObject({ status: "CANCELLED", cancelledBy: "customer" });
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    for (const w of [cws, drv.ws]) w.close();
  });

  it("Postgres down → the drop is refused, nothing changes", async () => {
    const p = spot();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Tetap");
    const { rideId, cws } = await accepted(p, drv);

    await postgres(zoneOf(p), "down");
    const res = await dropRide(rideId, drv.token);
    expect(res.status).toBe(503);
    await postgres(zoneOf(p), "off");
    await sleep(300);
    expect(cws.inbox.some((m) => m.t === "ride.status" && m.status === "REQUESTED")).toBe(false);
    expect(await pgRide(rideId)).toMatchObject({ status: "ACCEPTED", driverId: drv.id });
    // still this driver's ride: the trip goes on
    drv.ws.send({ t: "ride.arrived", rideId });
    await cws.next(status("ARRIVED"), 15_000);
    for (const w of [cws, drv.ws]) w.close();
  });

  it("Postgres commits but the reply is lost → the zone catches up: driver freed, search goes on", async () => {
    const p = spot();
    const first = await onlineDriver(off(p, 0.001).lat, p.lng, "Hilang");
    const second = await onlineDriver(off(p, 0.004).lat, p.lng, "Ganti");
    const { rideId, cws } = await accepted(p, first);

    await postgres(zoneOf(p), "lost-reply");
    expect((await dropRide(rideId, first.token)).status).toBe(503);
    expect(await pgRide(rideId)).toMatchObject({ status: "REQUESTED", driverId: null }); // it did land
    await postgres(zoneOf(p), "off");

    // the `sync:` timer finds it committed and applies it
    await cws.next(status("REQUESTED"), 15_000);
    expect((await first.ws.next((m) => m.t === "driver.state", 5_000)).status).toBe("AVAILABLE");
    expect((await second.ws.next("offer", 8_000)).rideId).toBe(rideId);
    expect((await dropRide(rideId, first.token)).status).toBe(200);
    for (const w of [cws, first.ws, second.ws]) w.close();
  });
});
