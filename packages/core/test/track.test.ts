import { describe, expect, it } from "vitest";
import { DEFAULT_TRACK_CONFIG, endTrack, sampleTrack, type TrackPt, type TrackState } from "../src";

// ~1 m of latitude / longitude near Jakarta
const M_LAT = 1 / 111_320;
const M_LNG = 1 / (111_320 * Math.cos((-6.2 * Math.PI) / 180));
const pt = (northM: number, eastM: number, at: number): TrackPt => ({ lat: -6.2 + northM * M_LAT, lng: 106.8 + eastM * M_LNG, at });

/** Feed every ping through the sampler, end the trip, return what was stored. */
function run(pings: TrackPt[], cfg = DEFAULT_TRACK_CONFIG): TrackPt[] {
  let state: TrackState | null = null;
  const stored: TrackPt[] = [];
  for (const p of pings) {
    const r = sampleTrack(state, p, cfg);
    stored.push(...r.keep);
    state = r.state;
  }
  return [...stored, ...endTrack(state)];
}

describe("sampleTrack", () => {
  it("a straight 2 km at one ping per 30 m keeps one point per 200 m, plus the first and the last", () => {
    const pings = Array.from({ length: 67 }, (_, i) => pt(i * 30, 0, i * 3_000)); // 0 … 1,980 m
    const stored = run(pings, { ...DEFAULT_TRACK_CONFIG, maxGapMs: Infinity });
    expect(stored.length).toBeLessThanOrEqual(12);
    expect(stored[0]).toEqual(pings[0]);
    expect(stored.at(-1)).toEqual(pings.at(-1));
    for (let i = 1; i < stored.length - 1; i++) expect(stored[i]!.at).toBeGreaterThan(stored[i - 1]!.at);
  });

  it("keeps the corner of a right turn even between two far points", () => {
    // 90 m north, then east: the corner (90, 0) is not 200 m from anything kept
    const pings = [pt(0, 0, 0), pt(30, 0, 1), pt(60, 0, 2), pt(90, 0, 3), pt(90, 30, 4), pt(90, 60, 5)];
    const stored = run(pings);
    expect(stored).toEqual([pings[0], pings[3], pings[5]]);
  });

  it("one ping a second (~8 m apart): the corner is still kept, the line never strays past toleranceM", async () => {
    // 150 m north, then 150 m east, 8 m per ping
    const pings: TrackPt[] = [];
    for (let m = 0; m <= 150; m += 8) pings.push(pt(m, 0, pings.length * 1_000));
    for (let m = 8; m <= 150; m += 8) pings.push(pt(150, m, pings.length * 1_000));
    const stored = run(pings);
    expect(stored.length).toBeLessThanOrEqual(4);
    // a stored point near the corner (150, 0)
    expect(stored.some((p) => Math.hypot((p.lat - pt(150, 0, 0).lat) / M_LAT, (p.lng - pt(150, 0, 0).lng) / M_LNG) <= DEFAULT_TRACK_CONFIG.toleranceM)).toBe(true);
  });

  it("GPS jitter while standing still makes no corners", () => {
    const pings = [pt(0, 0, 0), pt(5, -4, 1_000), pt(-3, 6, 2_000), pt(4, 3, 3_000), pt(-5, -2, 4_000)];
    expect(run(pings)).toEqual([pings[0], pings[4]]);
  });

  it("a long stop still leaves a point every maxGapMs", () => {
    const pings = Array.from({ length: 13 }, (_, i) => pt(0, 0, i * 10_000)); // 2 minutes, not moving
    expect(run(pings).map((p) => p.at)).toEqual([0, 60_000, 120_000]);
  });

  it("minGapM 0 keeps every ping", () => {
    const pings = [pt(0, 0, 0), pt(30, 0, 1), pt(60, 0, 2), pt(90, 0, 3)];
    expect(run(pings, { ...DEFAULT_TRACK_CONFIG, minGapM: 0 })).toEqual(pings);
  });

  it("ending a trip without a held ping adds nothing", () => {
    expect(endTrack(null)).toEqual([]);
    expect(endTrack(sampleTrack(null, pt(0, 0, 0)).state)).toEqual([]);
  });
});
