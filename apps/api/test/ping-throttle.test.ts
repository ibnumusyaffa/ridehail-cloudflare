import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { inZone, onlineDriver } from "./helpers";

// A driver standing still keeps pinging (heartbeat). The match actor drops those pings from memory,
// before any SQLite read, unless LOC_MIN_INTERVAL_MS passed or the driver moved LOC_MIN_MOVE_M.
// Tests run with the throttle off; this zone turns it on for its own match actor.

const b = geohashBounds(geohashEncode(-7.55, 110.45, 5)); // Solo: no other test uses it
const p = { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
const zone = geohashEncode(p.lat, p.lng, 5);

/** Turn the idle throttle on for this zone's match actor and count its driver-row reads. */
async function throttleOn(intervalMs: number) {
  await inZone(zone, "match", (inst) => {
    inst.cfg = { ...inst.cfg, presence: { ...inst.cfg.presence, locMinIntervalMs: intervalMs } };
    inst.reads = 0;
    const real = Object.getPrototypeOf(inst).loadDriver;
    inst.loadDriver = function (this: any, id: string) {
      this.reads++;
      return real.call(this, id);
    };
  });
}

/** Driver-row reads since `throttleOn`, and the driver's in-memory position. */
async function state(driverId: string) {
  let out = { reads: 0, lat: 0, ts: 0 };
  await inZone(zone, "match", (inst) => {
    const pos = inst.pos.get(driverId);
    out = { reads: inst.reads, lat: pos.lat, ts: pos.ts };
  });
  return out;
}

describe("idle ping throttle (match actor)", () => {
  it("drops a still driver's pings before reading SQLite, keeps a real move", async () => {
    const d = await onlineDriver(p.lat, p.lng, "Diam");
    await throttleOn(60_000);
    const before = await state(d.id);

    // GPS jitter (~11 m) a few times: dropped from memory, no driver-row read, position unchanged
    for (let i = 0; i < 5; i++) d.ws.send({ t: "loc", lat: p.lat + 0.0001, lng: p.lng });
    d.ws.send({ t: "resume" }); // answered after the pings above: they have been handled
    await d.ws.next("driver.state");
    const still = await state(d.id);
    expect(still.reads).toBe(1); // the resume only
    expect(still.lat).toBe(before.lat);
    expect(still.ts).toBe(before.ts);

    // a real move (~110 m) is kept at once
    d.ws.send({ t: "loc", lat: p.lat + 0.001, lng: p.lng });
    d.ws.send({ t: "resume" });
    await d.ws.next("driver.state");
    const moved = await state(d.id);
    expect(moved.lat).toBeCloseTo(p.lat + 0.001, 6);
    expect(moved.ts).toBeGreaterThan(before.ts);
    d.ws.close();
  });

  it("a match actor refuses to hold a driver ON_RIDE (the throttle's invariant)", async () => {
    const d = await onlineDriver(p.lat - 0.01, p.lng - 0.01, "Aturan");
    let error = "";
    await inZone(zone, "match", (inst) => {
      const row = inst.loadDriver(d.id);
      try {
        inst.saveDriver({ ...row, status: "ON_RIDE", rideId: `${zone}_x` });
      } catch (e) {
        error = (e as Error).message;
      }
      expect(inst.loadDriver(d.id).status).toBe("AVAILABLE");
    });
    expect(error).toContain("ON_RIDE");
    d.ws.close();
  });

  it("keeps a still driver's heartbeat once the interval has passed", async () => {
    const q = { lat: p.lat + 0.01, lng: p.lng + 0.01 };
    const d = await onlineDriver(q.lat, q.lng, "Mangkal");
    await throttleOn(0); // the interval has passed for every ping
    const before = await state(d.id);
    await new Promise((r) => setTimeout(r, 5));
    d.ws.send({ t: "loc", ...q });
    d.ws.send({ t: "resume" });
    await d.ws.next("driver.state");
    const after = await state(d.id);
    expect(after.reads).toBe(2); // the heartbeat and the resume
    expect(after.ts).toBeGreaterThan(before.ts);
    d.ws.close();
  });
});
