import { describe, expect, it } from "vitest";
import { rankCandidates, type DriverSnapshot } from "../src";

const pickup = { lat: -6.2, lng: 106.8 };
const now = 1_000_000;
const d = (id: string, dLat: number, extra: Partial<DriverSnapshot> = {}): DriverSnapshot => ({
  id, lat: pickup.lat + dLat, lng: pickup.lng, status: "AVAILABLE", updatedAt: now, ...extra,
});

describe("rankCandidates", () => {
  it("orders by distance", () => {
    const r = rankCandidates(pickup, [d("far", 0.015), d("near", 0.001), d("mid", 0.01)], { now });
    expect(r.map((c) => c.driverId)).toEqual(["near", "mid", "far"]);
  });
  it("skips busy, stale, rejected and too-far drivers", () => {
    const r = rankCandidates(
      pickup,
      [
        d("busy", 0.001, { status: "ON_RIDE" }),
        d("reserved", 0.001, { status: "RESERVED", reservedUntil: now + 5_000 }),
        d("offline", 0.001, { status: "OFFLINE" }),
        d("stale", 0.001, { updatedAt: now - 46_000 }),
        d("rejected", 0.001),
        d("toofar", 0.1), // ~11km
        d("ok", 0.002),
        d("lapsed", 0.003, { status: "RESERVED", reservedUntil: now - 1 }),
      ],
      { now, exclude: new Set(["rejected"]) },
    );
    expect(r.map((c) => c.driverId)).toEqual(["ok", "lapsed"]);
  });
  it("keeps a still driver whose heartbeats were lost twice (45 s staleness)", () => {
    // idle heartbeat every ~10 s: two lost in a row leave a ~30 s gap, still matchable
    const r = rankCandidates(pickup, [d("gap", 0.001, { updatedAt: now - 32_000 }), d("gone", 0.002, { updatedAt: now - 46_000 })], { now });
    expect(r.map((c) => c.driverId)).toEqual(["gap"]);
  });
  it("pickup radius is 2 km by default", () => {
    // 0.001° latitude ≈ 111 m
    const r = rankCandidates(pickup, [d("in", 0.017), d("out", 0.019)], { now }); // ~1.9 km, ~2.1 km
    expect(r.map((c) => c.driverId)).toEqual(["in"]);
  });
  it("takes top k and dedups", () => {
    const many = Array.from({ length: 20 }, (_, i) => d(`d${i}`, i * 0.0001));
    const r = rankCandidates(pickup, [...many, ...many], { now });
    expect(r).toHaveLength(10);
    expect(r[0]!.driverId).toBe("d0");
  });
});
