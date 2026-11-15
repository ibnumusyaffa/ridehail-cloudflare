import { haversineM } from "./geo";
import type { LatLng } from "./types";

export type TrackPt = LatLng & { at: number };

export interface TrackConfig {
  /** Keep a point once the driver is this far from the last kept one (straight stretches). */
  minGapM: number;
  /** …or once this long has passed since it, so a stop in traffic still shows in the history. */
  maxGapMs: number;
  /**
   * The stored route never strays further than this from a ping: a point is kept as soon as
   * skipping it would bend the line more than this (turns, curves). Above GPS noise (~5–10 m).
   */
  toleranceM: number;
}

export const DEFAULT_TRACK_CONFIG: TrackConfig = {
  minGapM: 200,
  maxGapMs: 60_000,
  toleranceM: 25,
};

/** The sampler's memory for one trip: the last kept point, and the pings since then not kept (yet). */
export interface TrackState {
  kept: TrackPt;
  /** at most `maxGapMs` worth of pings (bounded by the time rule) */
  held: TrackPt[];
}

/**
 * Thin a trip's route as its pings arrive: the history only has to show where the trip went, not
 * every ping. Keeps the first point, one point per `minGapM` (or `maxGapMs`), and the point before
 * any ping that would make the line from the last kept point stray more than `toleranceM` from the
 * pings it skips (turns, curves). Pure: returns the points to store now (0–2) and the next state.
 */
export function sampleTrack(
  state: TrackState | null,
  p: TrackPt,
  cfg: TrackConfig = DEFAULT_TRACK_CONFIG,
): { keep: TrackPt[]; state: TrackState } {
  if (!state) return { keep: [p], state: { kept: p, held: [] } };
  const keep: TrackPt[] = [];
  let kept = state.kept;
  let held = state.held;
  if (held.some((h) => offLineM(h, kept, p) > cfg.toleranceM)) {
    // the road bent: the last ping before this one ends the straight piece
    kept = held[held.length - 1]!;
    keep.push(kept);
    held = [];
  }
  if (haversineM(kept, p) >= cfg.minGapM || p.at - kept.at >= cfg.maxGapMs) {
    keep.push(p);
    return { keep, state: { kept: p, held: [] } };
  }
  return { keep, state: { kept, held: [...held, p] } };
}

/** The trip is over: its last position, still held back, is kept too (the route reaches the drop-off). */
export function endTrack(state: TrackState | null | undefined): TrackPt[] {
  const last = state?.held.at(-1);
  return last ? [last] : [];
}

/** Metres from `p` to the segment a–b (flat approximation; fine over a few hundred metres). */
function offLineM(p: LatLng, a: LatLng, b: LatLng): number {
  const mLng = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const px = (p.lng - a.lng) * mLng;
  const py = (p.lat - a.lat) * 111_320;
  const bx = (b.lng - a.lng) * mLng;
  const by = (b.lat - a.lat) * 111_320;
  const len2 = bx * bx + by * by;
  const u = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - u * bx, py - u * by);
}
