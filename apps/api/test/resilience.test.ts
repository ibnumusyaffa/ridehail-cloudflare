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

const pgRide = (id: string) => withSql(env as unknown as Env, (sql) => db.getRide(sql, id));

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
  it("cancel during an outage is refused, nothing changes; after recovery the retry cancels and unlocks", async () => {
    const p = spot();
    const c = await customer(50_000);
    const created = await order(c.token, p, "WALLET");
    expect(created.status).toBe(201);
    const rideId: string = created.json.rideId;
    const fare: number = created.json.ride.fare;
    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");

    await postgres(zoneOf(p), "down");
    const refused = await api(`/rides/${rideId}/cancel`, { token: c.token, body: { reason: "changed plans" } });
    expect(refused.status).toBe(503);
    expect(refused.json.error.code).toBe("UNAVAILABLE");
    await sleep(300);
    expect(cws.inbox.some((m) => m.t === "ride.status" && m.status === "CANCELLED")).toBe(false);
    expect((await pgRide(rideId))?.status).toBe("REQUESTED");
    expect((await api("/wallet", { token: c.token })).json.held).toBe(fare);

    await postgres(zoneOf(p), "off");
    const cancelled = await api(`/rides/${rideId}/cancel`, { token: c.token, body: { reason: "changed plans" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.ride.status).toBe("CANCELLED");
    await cws.next(status("CANCELLED"));
    expect((await api(`/rides/${rideId}`, { token: c.token })).json.ride.status).toBe("CANCELLED");
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    expect((await order(c.token, p)).status).toBe(201);
    cws.close();
  });

  it("cancel: Postgres commits but the reply is lost → the zone catches up on its own, a retry is OK", async () => {
    const p = spot();
    const c = await customer(50_000);
    const rideId: string = (await order(c.token, p, "WALLET")).json.rideId;
    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");

    await postgres(zoneOf(p), "lost-reply");
    expect((await api(`/rides/${rideId}/cancel`, { token: c.token, body: {} })).status).toBe(503);
    expect((await pgRide(rideId))?.status).toBe("CANCELLED"); // it did land
    await postgres(zoneOf(p), "off");

    // the `sync:` timer re-sends the write, finds it committed and applies it (no retry needed)
    await cws.next(status("CANCELLED"), 15_000);
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    const again = await api(`/rides/${rideId}/cancel`, { token: c.token, body: {} });
    expect(again.status).toBe(200);
    expect(again.json.ride.status).toBe("CANCELLED");
    cws.close();
  });

  it("cancel during an outage, nobody retries → it never happens; the ride carries on", async () => {
    const p = spot();
    const c = await customer(50_000);
    const rideId: string = (await order(c.token, p, "WALLET")).json.rideId;
    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");

    await postgres(zoneOf(p), "down");
    expect((await api(`/rides/${rideId}/cancel`, { token: c.token, body: {} })).status).toBe(503);
    await postgres(zoneOf(p), "off");

    // the `sync:` timer fences the lost write; the search (no drivers here) then ends as usual
    const end = await cws.next((m) => m.t === "ride.status" && ["NO_DRIVER", "CANCELLED"].includes(m.status), 15_000);
    expect(end.status).toBe("NO_DRIVER");
    expect((await pgRide(rideId))?.status).toBe("NO_DRIVER");
    expect((await api(`/rides/${rideId}`, { token: c.token })).json.ride.status).toBe("NO_DRIVER");
    expect((await api("/wallet", { token: c.token })).json.held).toBe(0);
    cws.close();
  });

  it("complete during an outage is refused; after recovery it completes and settles in one go", async () => {
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
    expect((await drv.ws.next("error")).code).toBe("UNAVAILABLE");
    expect(cws.inbox.some((m) => m.t === "ride.status" && m.status === "COMPLETED")).toBe(false);

    await postgres(zoneOf(p), "off");
    drv.ws.send({ t: "ride.complete", rideId });
    await cws.next(status("COMPLETED"));
    const paid = await cws.next("ride.paid");
    expect(paid.paidVia).toBe("WALLET");
    expect(paid.balance).toBe(100_000 - fare);
    expect((await drv.ws.next((m) => m.t === "driver.state" && m.status === "AVAILABLE")).rideId).toBeNull();
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 100_000 - fare, held: 0 });
    expect((await api(`/rides/${rideId}`, { token: c.token })).json.ride.status).toBe("COMPLETED");
    cws.close();
    drv.ws.close();
  });

  it("complete: reply lost → the zone applies it, frees the driver and settles", async () => {
    const p = spot();
    const c = await customer(100_000);
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Budi");
    const created = await order(c.token, p, "WALLET");
    const rideId: string = created.json.rideId;
    const fare: number = created.json.ride.fare;
    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");
    await drv.ws.next("offer");
    drv.ws.send({ t: "offer.accept", rideId });
    for (const t of ["ride.arrived", "ride.start"]) drv.ws.send({ t, rideId });
    await cws.next(status("ON_TRIP"));

    await postgres(zoneOf(p), "lost-reply");
    drv.ws.send({ t: "ride.complete", rideId });
    expect((await drv.ws.next("error")).code).toBe("UNAVAILABLE");
    await postgres(zoneOf(p), "off");

    await cws.next(status("COMPLETED"), 15_000);
    const paid = await cws.next("ride.paid", 15_000);
    expect(paid.balance).toBe(100_000 - fare);
    expect((await drv.ws.next((m) => m.t === "driver.state" && m.status === "AVAILABLE", 15_000)).rideId).toBeNull();
    cws.close();
    drv.ws.close();
  });

  it("accept and cancel at the same time: exactly one wins, Postgres and the zone agree", async () => {
    const p = spot();
    const c = await customer();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Rudi");
    const rideId: string = (await order(c.token, p)).json.rideId;
    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");
    await drv.ws.next("offer");

    drv.ws.send({ t: "offer.accept", rideId });
    const cancel = await api(`/rides/${rideId}/cancel`, { token: c.token, body: {} });
    expect(cancel.status).toBe(200);
    const final = cancel.json.ride.status;
    // cancelled either before the accept (driver gets an error) or after it (ACCEPTED → CANCELLED)
    expect(final).toBe("CANCELLED");
    const pg = await pgRide(rideId);
    expect(pg?.status).toBe("CANCELLED");
    expect((await api(`/rides/${rideId}`, { token: c.token })).json.ride.status).toBe("CANCELLED");
    // the driver is free again whichever way it went
    const st = await drv.ws.next((m) => (m.t === "driver.state" && m.status === "AVAILABLE") || m.t === "offer.cancelled" || m.t === "error");
    expect(st).toBeTruthy();
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
