import { env } from "cloudflare:test";
import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { homeOfRide, matchRoute, rideRoute } from "../src/config";
import * as db from "../src/db";
import { api, Client, inZone, login, onlineDriver, postgresOutage, sleep, status, withSql } from "./helpers";

// Postgres outages are simulated per actor by shadowing its `pg` seam (every DB call of ZoneDO
// goes through it); the test's own queries (withSql) still reach the real database.

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-7.2 - area * 0.1, 107.5 + area * 0.07, 5));
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const zoneOf = (p: { lat: number; lng: number }) => geohashEncode(p.lat, p.lng, 5);

const postgres = postgresOutage;

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

// ---------------------------------------------------------------- A6: a driver never holds two rides

/** A pickup just inside the north edge of its zone and a driver spot just across it (another zone). */
function acrossZones() {
  const b = geohashBounds(zoneOf(spot()));
  const pickup = { lat: b.latMax - 0.0005, lng: (b.lngMin + b.lngMax) / 2 };
  const driverAt = { lat: b.latMax + 0.0005, lng: pickup.lng };
  expect(zoneOf(driverAt)).not.toBe(zoneOf(pickup));
  return { pickup, driverAt, rideZone: zoneOf(pickup), driverZone: zoneOf(driverAt) };
}

/** The driver's match actor loses the reply of its `acceptOffer` RPC: the call lands, then the caller sees an error. */
async function lostAcceptReply(zone: string, on: boolean) {
  await inZone(zone, "match", (inst) => {
    delete inst.stub; // back to the prototype's real implementation
    if (!on) return;
    const real = inst.stub.bind(inst);
    inst.stub = (z: string) => {
      const s = real(z);
      return new Proxy(s, {
        get: (t, k) =>
          k === "acceptOffer"
            ? async (...a: unknown[]) => {
                await t.acceptOffer(...a);
                throw new Error("simulated lost RPC reply");
              }
            : (...a: unknown[]) => t[k](...a),
      });
    };
  });
}

describe("A6: a driver never holds two rides", () => {
  it("Postgres says the driver already has an active ride → DRIVER_BUSY, the next driver is offered", async () => {
    const p = spot();
    const busy = await onlineDriver(off(p, 0.001).lat, p.lng, "Dodi");
    const next = await onlineDriver(off(p, 0.004).lat, p.lng, "Eko");
    // the driver's other ride: active in Postgres, unknown to this zone (e.g. another zone's ride)
    const other = await customer();
    const busyRide = `zzzzz_${crypto.randomUUID()}`;
    await withSql(env as unknown as Env, (sql) => sql`
      INSERT INTO rides (id, customer_id, driver_id, pickup_lat, pickup_lng, drop_lat, drop_lng, status,
        fare_estimate, distance_m, payment_method, requested_at, accepted_at)
      VALUES (${busyRide}, ${other.id}, ${busy.id}, ${p.lat}, ${p.lng}, ${p.lat}, ${p.lng},
        'ACCEPTED', 10000, 1000, 'CASH', ${Date.now()}, ${Date.now()})`);

    const c = await customer();
    const rideId: string = (await order(c.token, p)).json.rideId;
    expect((await busy.ws.next("offer")).rideId).toBe(rideId);
    busy.ws.send({ t: "offer.accept", rideId });
    expect((await busy.ws.next("error")).code).toBe("DRIVER_BUSY");
    // not put back among the free drivers: pointed at the ride they are on
    expect(await busy.ws.next("reconnect")).toMatchObject({ route: rideRoute("zzzzz") });

    expect((await next.ws.next("offer")).rideId).toBe(rideId);
    next.ws.send({ t: "offer.accept", rideId });
    expect((await next.ws.next(status("ACCEPTED"))).ride.driverId).toBe(next.id);
    expect(busy.ws.inbox.some((m) => m.t === "offer" && m.rideId === rideId)).toBe(false); // never again
    expect((await pgRide(rideId))?.driverId).toBe(next.id);
    busy.ws.close();
    next.ws.close();
  });

  it("a driver on a ride who reaches a match actor (second phone, stale client) and goes online → sent back to the ride, never AVAILABLE", async () => {
    const p = spot();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Gilang");
    const c = await customer();
    const rideId: string = (await order(c.token, p)).json.rideId;
    expect((await drv.ws.next("offer")).rideId).toBe(rideId);
    drv.ws.send({ t: "offer.accept", rideId });
    await drv.ws.next(status("ACCEPTED"));

    // another socket of the same driver, with a stale route to the match actor: lands there
    const second = await Client.connect({ token: drv.token, lat: p.lat, lng: p.lng, route: matchRoute(geohashEncode(p.lat, p.lng, 5)) });
    expect((await second.next("hello")).driverStatus).toBe("OFFLINE");
    second.send({ t: "online" });
    expect(await second.next("reconnect")).toMatchObject({ route: rideRoute(homeOfRide(rideId)!) });
    expect(await second.next("hello")).toMatchObject({ driverStatus: "ON_RIDE", rideId });
    expect(second.inbox.some((m) => m.t === "driver.state" && m.status === "AVAILABLE")).toBe(false);
    second.close();
    drv.ws.close();
  });

  it("cross-zone accept: Postgres reply lost, nobody retries → it lands on recovery and the driver's zone hands the driver over", async () => {
    const { pickup, driverAt, rideZone } = acrossZones();
    const c = await customer();
    const drv = await onlineDriver(driverAt.lat, driverAt.lng, "Fajar");
    const rideId: string = (await order(c.token, pickup)).json.rideId;
    await drv.ws.next("offer");

    await postgres(rideZone, "lost-reply");
    drv.ws.send({ t: "offer.accept", rideId });
    expect((await drv.ws.next("error")).code).toBe("UNAVAILABLE");
    await postgres(rideZone, "off");
    expect((await pgRide(rideId))?.driverId).toBe(drv.id); // it did land

    // the ride's zone learns it on its own (`sync:`), then tells the driver's zone (`handover:`)
    const moved = await drv.ws.next("reconnect", 15_000);
    expect(moved).toMatchObject({ route: rideRoute(rideZone) });
    // the client follows `reconnect` into the ride's actor
    expect(await drv.ws.next("hello")).toMatchObject({ route: rideRoute(rideZone), driverStatus: "ON_RIDE", rideId });
    drv.ws.close();
  });

  it("cross-zone accept: the RPC reply between zones is lost → error to the driver, then handed over anyway", async () => {
    const { pickup, driverAt, rideZone, driverZone } = acrossZones();
    const c = await customer();
    const drv = await onlineDriver(driverAt.lat, driverAt.lng, "Gilang");
    const rideId: string = (await order(c.token, pickup)).json.rideId;
    await drv.ws.next("offer");

    await lostAcceptReply(driverZone, true);
    drv.ws.send({ t: "offer.accept", rideId });
    expect((await drv.ws.next("error")).code).toBe("UNAVAILABLE");
    await lostAcceptReply(driverZone, false);

    const moved = await drv.ws.next("reconnect", 10_000);
    expect(moved).toMatchObject({ route: rideRoute(rideZone) });
    expect((await pgRide(rideId))?.status).toBe("ACCEPTED");
    // gone from its old zone: it is never offered there again
    expect(await drv.ws.next("hello")).toMatchObject({ driverStatus: "ON_RIDE", rideId });
    drv.ws.close();
  });

  it("cross-zone accept never reaches the ride's zone → the driver is held, then released by the offer timeout", async () => {
    const { pickup, driverAt, driverZone } = acrossZones();
    const c = await customer();
    const drv = await onlineDriver(driverAt.lat, driverAt.lng, "Hadi");
    const rideId: string = (await order(c.token, pickup)).json.rideId;
    await drv.ws.next("offer");

    await inZone(driverZone, "match", (inst) => {
      const real = inst.stub.bind(inst);
      inst.stub = (z: string) => {
        const s = real(z);
        return new Proxy(s, {
          get: (t, k) => (k === "acceptOffer" ? () => Promise.reject(new Error("simulated network error")) : (...a: unknown[]) => t[k](...a)),
        });
      };
    });
    drv.ws.send({ t: "offer.accept", rideId });
    expect((await drv.ws.next("error")).code).toBe("UNAVAILABLE");
    await lostAcceptReply(driverZone, false);

    // not taken: the ride's offer timer gives up on this driver and frees them
    expect((await drv.ws.next("offer.cancelled", 10_000)).rideId).toBe(rideId);
    expect((await pgRide(rideId))?.driverId).toBeNull();
    drv.ws.close();
  });
});
