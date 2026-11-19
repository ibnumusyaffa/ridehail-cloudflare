import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { api, Client, inZone, login, onlineDriver, status } from "./helpers";

// A driver can only mark "arrived" near the pickup and complete a trip near the dropoff (A5).
// vitest.config.ts turns the check off for every other test; each test here turns it on for its own zone.

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-5.0 - area * 0.1, 104.6 + area * 0.07, 5)); // Lampung: no other test uses it
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const zoneOf = (p: { lat: number; lng: number }) => geohashEncode(p.lat, p.lng, 5);

const ARRIVE_M = 200;
const COMPLETE_M = 300;

/** A CASH ride accepted by a driver `startAt` (within the 2 km search radius); the customer watches it. */
async function accepted(startAt: (p: { lat: number; lng: number }) => { lat: number; lng: number }) {
  const p = spot();
  const dropoff = off(p, 0.03, 0.02); // ~4 km away
  await inZone(zoneOf(p), "ride", (inst) => {
    inst.cfg.atPlace = { arriveM: ARRIVE_M, completeM: COMPLETE_M };
  });
  const c = await login("customer", "Sari");
  const start = startAt(p);
  const drv = await onlineDriver(start.lat, start.lng, "Agus");
  const created = await api("/rides", { token: c.token, body: { pickup: p, dropoff, paymentMethod: "CASH" } });
  expect(created.status).toBe(201);
  const rideId: string = created.json.rideId;
  const cws = await Client.connect({ token: c.token, rideId });
  await cws.next("hello");
  await drv.ws.next("offer");
  drv.ws.send({ t: "offer.accept", rideId });
  await cws.next(status("ACCEPTED"));
  // the driver follows `reconnect` into the ride's actor
  await drv.ws.next((m) => m.t === "hello" && m.driverStatus === "ON_RIDE");
  return { p, dropoff, drv, rideId, cws };
}

/** Send a ping and wait until the ride's actor took it (the customer sees it). */
async function moveTo(drv: { ws: Client }, cws: Client, at: { lat: number; lng: number }) {
  drv.ws.send({ t: "loc", ...at });
  await cws.next("driver.loc");
}

describe("arrive and complete only at the right place", () => {
  it("rejects arrive away from the pickup and complete away from the dropoff, then accepts both on the spot", async () => {
    const { p, dropoff, drv, rideId, cws } = await accepted((p) => off(p, 0.01)); // ~1.1 km from pickup

    // still where they accepted (the position handed over with the driver, no ping yet)
    drv.ws.send({ t: "ride.arrived", rideId });
    const far = await drv.ws.next("error");
    expect(far.code).toBe("TOO_FAR");
    expect(far.message).toMatch(/from the pickup \(must be within 200 m\)/);

    await moveTo(drv, cws, off(p, 0.003)); // ~330 m: still too far
    drv.ws.send({ t: "ride.arrived", rideId });
    expect((await drv.ws.next("error")).code).toBe("TOO_FAR");
    expect(cws.inbox.some((m) => m.t === "ride.status" && m.status === "ARRIVED")).toBe(false);

    await moveTo(drv, cws, off(p, 0.001)); // ~110 m: close enough
    drv.ws.send({ t: "ride.arrived", rideId });
    await cws.next(status("ARRIVED"));
    drv.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));

    // completing at the pickup: the trip never happened
    drv.ws.send({ t: "ride.complete", rideId });
    const early = await drv.ws.next("error");
    expect(early.code).toBe("TOO_FAR");
    expect(early.message).toMatch(/from the dropoff \(must be within 300 m\)/);

    await moveTo(drv, cws, off(dropoff, 0.002)); // ~220 m short of the pin: fine
    drv.ws.send({ t: "ride.complete", rideId });
    await cws.next(status("COMPLETED"));
    expect((await cws.next("ride.paid")).rideId).toBe(rideId);
    drv.ws.close();
    cws.close();
  });
});
