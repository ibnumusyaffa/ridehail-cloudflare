import { describe, expect, it } from "vitest";
import { computeFare, DEFAULT_FARE_CONFIG, estimate } from "../src";

describe("fare", () => {
  it("applies min fare", () => {
    expect(computeFare(0)).toBe(DEFAULT_FARE_CONFIG.minFare);
    expect(computeFare(1_000)).toBe(10_000); // 5000 + 2500 = 7500 < min
  });
  it("base + per km, rounded up to 500", () => {
    expect(computeFare(4_000)).toBe(15_000); // 5000 + 10000
    expect(computeFare(4_100)).toBe(15_500); // 15250 -> 15500
    expect(computeFare(10_000) % 500).toBe(0);
  });
  it("estimate uses haversine × factor", () => {
    const e = estimate({ lat: -6.1754, lng: 106.8272 }, { lat: -6.1949, lng: 106.823 });
    expect(e.distanceM).toBeGreaterThan(2_700);
    expect(e.distanceM).toBeLessThan(3_000);
    expect(Number.isInteger(e.fare)).toBe(true);
  });
});
