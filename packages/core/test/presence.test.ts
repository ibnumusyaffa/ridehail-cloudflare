import { describe, expect, it } from "vitest";
import {
  acceptPing,
  distanceInsideCellM,
  geohashBounds,
  geohashChildren,
  geohashEncode,
  haversineM,
  shouldHandOff,
  shouldSendPing,
} from "../src";

describe("geohashChildren", () => {
  it("expands a cell to every child at the target precision", () => {
    const kids = geohashChildren("qqguy", 6);
    expect(kids).toHaveLength(32);
    expect(kids.every((k) => k.startsWith("qqguy") && k.length === 6)).toBe(true);
    expect(geohashChildren("qqguy", 5)).toEqual(["qqguy"]);
    expect(geohashChildren("qqgu", 6)).toHaveLength(1024);
  });
});

describe("distanceInsideCellM", () => {
  const zone = geohashEncode(-6.2, 106.8, 5);
  const b = geohashBounds(zone);
  const midLng = (b.lngMin + b.lngMax) / 2;
  it("is positive inside, negative outside, ~0 on the edge", () => {
    expect(distanceInsideCellM({ lat: (b.latMin + b.latMax) / 2, lng: midLng }, zone)).toBeGreaterThan(1_000);
    expect(distanceInsideCellM({ lat: b.latMax + 0.001, lng: midLng }, zone)).toBeLessThan(0);
    expect(Math.abs(distanceInsideCellM({ lat: b.latMax, lng: midLng }, zone))).toBeLessThan(1);
    expect(distanceInsideCellM({ lat: b.latMax - 0.0009, lng: midLng }, zone)).toBeCloseTo(100, -1);
  });
});

describe("acceptPing", () => {
  const at = (ms: number, dLat = 0) => ({ lat: -6.2 + dLat, lng: 106.8, at: ms });
  it("throttles idle drivers harder than drivers on a ride", () => {
    expect(acceptPing(null, at(1_000), false)).toBe(true);
    expect(acceptPing(at(1_000), at(2_500), false)).toBe(false);
    expect(acceptPing(at(1_000), at(3_000), false)).toBe(true);
    expect(acceptPing(at(1_000), at(2_000), true)).toBe(true);
    expect(acceptPing(at(1_000), at(1_500), true)).toBe(false);
  });
  it("never drops a ping that really moved", () => {
    expect(acceptPing(at(1_000), at(1_100, 0.0001), false)).toBe(false); // ~11 m jitter
    expect(acceptPing(at(1_000), at(1_100, 0.01), false)).toBe(true); // ~1.1 km jump
  });
});

describe("shouldHandOff", () => {
  const zone = geohashEncode(-6.2, 106.8, 5);
  const b = geohashBounds(zone);
  const lng = (b.lngMin + b.lngMax) / 2;
  const nearEdge = { lat: b.latMin + 0.0002, lng }; // ~22 m inside
  const deep = { lat: b.latMin + 0.005, lng }; // ~550 m inside
  it("hands over at once when deep inside the new zone", () => {
    expect(shouldHandOff(deep, zone, 1)).toBe(true);
  });
  it("waits for consecutive pings when jittering on the border", () => {
    expect(shouldHandOff(nearEdge, zone, 1)).toBe(false);
    expect(shouldHandOff(nearEdge, zone, 2)).toBe(false);
    expect(shouldHandOff(nearEdge, zone, 3)).toBe(true);
  });
});

describe("shouldSendPing", () => {
  const p = { lat: -6.2, lng: 106.8, at: 0 };
  it("sends after moving 30 m or after 5 s", () => {
    expect(shouldSendPing(null, p, haversineM)).toBe(true);
    expect(shouldSendPing(p, { lat: -6.2001, lng: 106.8, at: 1_000 }, haversineM)).toBe(false); // ~11 m
    expect(shouldSendPing(p, { lat: -6.2004, lng: 106.8, at: 1_000 }, haversineM)).toBe(true); // ~44 m
    expect(shouldSendPing(p, { lat: -6.2, lng: 106.8, at: 5_000 }, haversineM)).toBe(true);
  });
});
