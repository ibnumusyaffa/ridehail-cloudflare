import { env, runInDurableObject } from "cloudflare:test";
import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { api, Client, login, onlineDriver, sleep, status } from "./helpers";

// A driver whose phone dies mid-trip: after DRIVER_LOST_ASK_MS without a location ping the customer is
// asked what happened (and asked again every interval); after DRIVER_LOST_CANCEL_MS the ride is cancelled
// by the system. The intervals are shortened per zone actor (an hour / three hours by default).

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-6.6 - area * 0.1, 106.4 + area * 0.07, 5));
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const zoneOf = (p: { lat: number; lng: number }) => geohashEncode(p.lat, p.lng, 5);

async function lostAfter(zone: string, askMs: number, cancelMs: number) {
  const ns = (env as unknown as { ZONE: DurableObjectNamespace }).ZONE;
  const run = runInDurableObject as unknown as (stub: unknown, fn: (inst: any) => void) => Promise<void>;
  await run(ns.get(ns.idFromName(zone)), (inst) => {
    inst.cfg.driverLostAskMs = askMs;
    inst.cfg.driverLostCancelMs = cancelMs;
  });
}

async function customer(balance = 0) {
  const c = await login("customer", "Rina");
  if (balance) await api("/wallet/topup", { token: c.token, body: { amount: balance }, headers: { "Idempotency-Key": "init" } });
  return c;
}

const order = (token: string, p: { lat: number; lng: number }, paymentMethod = "WALLET") =>
  api("/rides", { token, body: { pickup: p, dropoff: off(p, 0.03, 0.02), paymentMethod } });

/** A WALLET ride on its way, then the driver's phone goes silent (socket closed, no more pings). */
async function tripThenSilence(askMs: number, cancelMs: number) {
  const p = spot();
  const c = await customer(100_000);
  const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Joko");
  await lostAfter(zoneOf(p), askMs, cancelMs);
  const created = await order(c.token, p);
  expect(created.status).toBe(201);
  const rideId: string = created.json.rideId;
  const fare: number = created.json.ride.fare;
  const cws = await Client.connect({ token: c.token, rideId });
  await cws.next("hello");
  await drv.ws.next("offer");
  drv.ws.send({ t: "offer.accept", rideId });
  for (const t of ["ride.arrived", "ride.start"]) drv.ws.send({ t, rideId });
  await cws.next(status("ON_TRIP"));
  drv.ws.close();
  return { p, c, drv, rideId, fare, cws };
}

const answer = (token: string, rideId: string, action: string) =>
  api(`/rides/${rideId}/driver-lost`, { token, body: { action } });

describe("driver goes silent during a trip", () => {
  it("customer is asked; 'arrived' completes the trip and pays the driver", async () => {
    const { c, drv, rideId, fare, cws } = await tripThenSilence(600, 60_000);
    const asked = await cws.next("ride.driver_lost");
    expect(asked.rideId).toBe(rideId);
    expect(asked.autoCancelAt).toBeGreaterThan(Date.now());

    const res = await answer(c.token, rideId, "arrived");
    expect(res.status).toBe(200);
    expect(res.json.ride.status).toBe("COMPLETED");
    await cws.next(status("COMPLETED"));
    expect((await cws.next("ride.paid")).balance).toBe(100_000 - fare);
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 100_000 - fare, held: 0 });
    expect((await api(`/rides/${rideId}`, { token: drv.token })).json.ride.status).toBe("COMPLETED");
    cws.close();
  });

  it("customer reports a problem: the trip is cancelled by the system, the hold released, a new order works", async () => {
    const { p, c, rideId, cws } = await tripThenSilence(600, 60_000);
    await cws.next("ride.driver_lost");

    const res = await answer(c.token, rideId, "cancel");
    expect(res.status).toBe(200);
    expect(res.json.ride).toMatchObject({ status: "CANCELLED", cancelledBy: "system" });
    await cws.next(status("CANCELLED"));
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 100_000, held: 0 });
    expect((await order(c.token, p, "CASH")).status).toBe(201);
    cws.close();
  });

  it("no answer: asked again each interval, then cancelled by the system", async () => {
    const { c, rideId, cws } = await tripThenSilence(500, 1_800);
    await cws.next("ride.driver_lost");
    await cws.next("ride.driver_lost");
    const end = await cws.next(status("CANCELLED"), 5_000);
    expect(end.ride).toMatchObject({ cancelledBy: "system", cancelReason: "driver_lost" });
    expect((await api(`/rides/${rideId}`, { token: c.token })).json.ride.status).toBe("CANCELLED");
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 100_000, held: 0 });
    cws.close();
  });

  it("driver comes back: the customer is told, and the question can no longer be answered", async () => {
    const { p, drv, c, rideId, cws } = await tripThenSilence(600, 60_000);
    await cws.next("ride.driver_lost");

    const back = await Client.connect({ token: drv.token, rideId });
    await back.next("hello");
    back.send({ t: "loc", lat: p.lat + 0.01, lng: p.lng });
    expect((await cws.next("ride.driver_back")).rideId).toBe(rideId);

    const res = await answer(c.token, rideId, "cancel");
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("INVALID_TRANSITION");
    back.send({ t: "ride.complete", rideId });
    await cws.next(status("COMPLETED"));
    cws.close();
    back.close();
  });

  it("refused before the customer was asked, for the driver, and for a bad action", async () => {
    const { c, drv, rideId, cws } = await tripThenSilence(60_000, 120_000);
    expect((await answer(c.token, rideId, "cancel")).status).toBe(409);
    expect((await answer(drv.token, rideId, "cancel")).status).toBe(403);
    expect((await answer(c.token, rideId, "whatever")).status).toBe(400);
    await sleep(50);
    expect((await api(`/rides/${rideId}`, { token: c.token })).json.ride.status).toBe("ON_TRIP");
    cws.close();
  });
});
