import { env, runInDurableObject } from "cloudflare:test";
import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { api, Client, login, onlineDriver, sleep, status } from "./helpers";

// The search for a driver must not stop quietly: a rejection that races the offer, a failing RPC to a
// zone, or a driver who comes online late must never end in a false NO_DRIVER. Faults are injected per
// zone actor by shadowing its methods (every call inside a zone goes through `this`).

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-8.1 - area * 0.1, 110.2 + area * 0.07, 5));
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

async function order(p: { lat: number; lng: number }) {
  const c = await login("customer", "Dewi");
  const res = await api("/rides", { token: c.token, body: { pickup: p, dropoff: off(p, 0.03, 0.02), paymentMethod: "CASH" } });
  expect(res.status).toBe(201);
  const rideId: string = res.json.rideId;
  const ws = await Client.connect({ token: c.token, rideId });
  await ws.next("hello");
  return { c, rideId, ws };
}

describe("driver search", () => {
  it("a driver who rejects while the first offer is still being written → the next driver is offered", async () => {
    const p = spot();
    const first = await onlineDriver(off(p, 0.001).lat, p.lng, "Cepat");
    const second = await onlineDriver(off(p, 0.003).lat, p.lng, "Kedua");
    await inZone(zoneOf(p), (inst) => {
      inst.cfg.offerTimeoutMs = 15_000; // only the rejection can move the search on in time
      const real = inst.reserveAndOffer.bind(inst);
      // the offer reaches the driver, then the reservation's reply is slow to come back
      inst.reserveAndOffer = async (...args: unknown[]) => {
        const ok = await real(...args);
        await new Promise((r) => setTimeout(r, 400));
        return ok;
      };
    });
    const { rideId, ws } = await order(p);

    const o = await first.ws.next("offer");
    first.ws.send({ t: "offer.reject", rideId: o.rideId });
    expect((await second.ws.next("offer", 4_000)).rideId).toBe(rideId);
    second.ws.send({ t: "offer.accept", rideId });
    await ws.next(status("ACCEPTED"));
    for (const c of [first.ws, second.ws, ws]) c.close();
  });

  it("reserveAndOffer fails (reply lost) → retried, the driver gets the ride", async () => {
    const p = spot();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Andi");
    await inZone(zoneOf(p), (inst) => {
      const real = inst.reserveAndOffer.bind(inst);
      let calls = 0;
      inst.reserveAndOffer = async (...args: unknown[]) => {
        const ok = await real(...args);
        if (++calls === 1) throw new Error("simulated lost RPC reply");
        return ok;
      };
    });
    const { rideId, ws } = await order(p);

    await drv.ws.next("offer"); // the first attempt reached the driver; its reply was lost
    const again = await drv.ws.next("offer", 8_000); // the retry offers again
    expect(again.rideId).toBe(rideId);
    drv.ws.send({ t: "offer.accept", rideId });
    await ws.next(status("ACCEPTED"));
    drv.ws.close();
    ws.close();
  });

  it("reserveAndOffer fails before reaching the driver → retried, the driver gets the ride", async () => {
    const p = spot();
    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Bayu");
    await inZone(zoneOf(p), (inst) => {
      const real = inst.reserveAndOffer.bind(inst);
      let calls = 0;
      inst.reserveAndOffer = async (...args: unknown[]) => {
        if (++calls === 1) throw new Error("simulated RPC failure");
        return real(...args);
      };
    });
    const { rideId, ws } = await order(p);

    expect((await drv.ws.next("offer", 8_000)).rideId).toBe(rideId);
    drv.ws.send({ t: "offer.accept", rideId });
    await ws.next(status("ACCEPTED"));
    drv.ws.close();
    ws.close();
  });

  it("a driver who comes online well after the order is still offered; NO_DRIVER only at the deadline", async () => {
    const p = spot();
    await inZone(zoneOf(p), (inst) => {
      inst.cfg.searchTimeoutMs = 10_000;
    });
    const { rideId, ws } = await order(p);
    await sleep(2_000); // several empty searches (RESEARCH_DELAY_MS is 300 in tests)
    expect(ws.inbox.some((m) => m.t === "ride.status" && m.status === "NO_DRIVER")).toBe(false);

    const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Telat");
    expect((await drv.ws.next("offer", 4_000)).rideId).toBe(rideId);
    drv.ws.send({ t: "offer.accept", rideId });
    await ws.next(status("ACCEPTED"));
    drv.ws.close();
    ws.close();
  });

  it("nobody around: NO_DRIVER comes at the search deadline, not after two empty searches", async () => {
    const p = spot();
    await inZone(zoneOf(p), (inst) => {
      inst.cfg.searchTimeoutMs = 3_000;
    });
    const t0 = Date.now();
    const { ws } = await order(p);
    await ws.next(status("NO_DRIVER"), 8_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500);
    ws.close();
  });

  it("a neighbouring zone that errors is skipped; drivers in the other zones are still found", async () => {
    const p = spot();
    const z = zoneOf(p);
    const b = geohashBounds(z);
    // pickup just inside the zone's southern edge: the search ring reaches into the zone below
    const pickup = { lat: b.latMin + 0.0005, lng: p.lng };
    const south = geohashEncode(b.latMin - 0.0005, p.lng, 5);
    expect(south).not.toBe(z);
    await inZone(z, (inst) => {
      const real = inst.stub.bind(inst);
      inst.stub = (zone: string) =>
        zone === south ? { nearest: () => Promise.reject(new Error("simulated zone failure")) } : real(zone);
    });
    const drv = await onlineDriver(pickup.lat + 0.001, pickup.lng, "Utara");
    const { rideId, ws } = await order(pickup);

    expect((await drv.ws.next("offer", 4_000)).rideId).toBe(rideId);
    drv.ws.send({ t: "offer.accept", rideId });
    await ws.next(status("ACCEPTED"));
    drv.ws.close();
    ws.close();
  });
});
