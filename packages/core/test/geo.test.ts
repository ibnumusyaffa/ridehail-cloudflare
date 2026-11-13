import { describe, expect, it } from "vitest";
import { geohashBounds, geohashEncode, geohashNeighborhood, haversineM, isGeohash } from "../src";

describe("geohash", () => {
  it("encodes known points", () => {
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
    // Monas, Jakarta
    expect(geohashEncode(-6.1754, 106.8272, 6).startsWith("qqgu")).toBe(true);
  });

  it("bounds contain the encoded point", () => {
    const h = geohashEncode(-6.2, 106.8, 7);
    const b = geohashBounds(h);
    expect(-6.2).toBeGreaterThanOrEqual(b.latMin);
    expect(-6.2).toBeLessThanOrEqual(b.latMax);
    expect(106.8).toBeGreaterThanOrEqual(b.lngMin);
    expect(106.8).toBeLessThanOrEqual(b.lngMax);
  });

  it("neighborhood = self + 8 distinct adjacent cells", () => {
    const h = "qqguyu";
    const n = geohashNeighborhood(h);
    expect(n).toHaveLength(9);
    expect(n).toContain(h);
    expect(new Set(n).size).toBe(9);
    // known neighbours of a geohash
    expect(geohashNeighborhood("u4pruy").sort()).toEqual(
      ["u4pruv", "u4pruw", "u4prux", "u4pruy", "u4pruz", "u4prvj", "u4prvn", "u4prvp", "u4prut"].sort(),
    );
  });

  it("neighborhood clamps at poles", () => {
    const top = geohashEncode(89.99, 0, 3);
    expect(geohashNeighborhood(top)).toHaveLength(6);
  });

  it("validates geohash strings", () => {
    expect(isGeohash("qqgu")).toBe(true);
    expect(isGeohash("qqga")).toBe(false);
    expect(isGeohash("")).toBe(false);
  });
});

describe("haversine", () => {
  it("is zero for same point", () => {
    expect(haversineM({ lat: -6.2, lng: 106.8 }, { lat: -6.2, lng: 106.8 })).toBe(0);
  });
  it("matches a known distance (Monas -> Bundaran HI ≈ 2.1km)", () => {
    const d = haversineM({ lat: -6.1754, lng: 106.8272 }, { lat: -6.1949, lng: 106.823 });
    expect(d).toBeGreaterThan(2_100);
    expect(d).toBeLessThan(2_300);
  });
});
