import { bearingDeg, haversineM } from "./geo";
import type { LatLng } from "./types";

export type TrackPt = LatLng & { at: number };

export interface TrackConfig {
  /** Keep a point once the driver is this far from the last kept one (straight stretches). */
  minGapM: number;
  /** …or once this long has passed since it, so a stop in traffic still shows in the history. */
  maxGapMs: number;
  /** Keep the corner of a turn sharper than this. */
  turnDeg: number;
  /** A leg shorter than this never makes a turn (GPS jitter while standing still). */
  turnMinLegM: number;
}

export const DEFAULT_TRACK_CONFIG: TrackConfig = {
  minGapM: 200,
  maxGapMs: 60_000,
  turnDeg: 30,
  turnMinLegM: 25,
};

/** The sampler's memory for one trip: the last kept point, and the latest ping not kept (yet). */
export interface TrackState {
  kept: TrackPt;
  held: TrackPt | null;
}

/**
 * Thin a trip's route as its pings arrive: the history only has to show where the trip went, not
 * every ping. Keeps the first point, one point per `minGapM` (or `maxGapMs`) on straight stretches,
 * and the corner of every turn. Each ping is held back until the next one shows whether it was a
 * corner. Pure: returns the points to store now (0–2) and the next state.
 */
export function sampleTrack(
  state: TrackState | null,
  p: TrackPt,
  cfg: TrackConfig = DEFAULT_TRACK_CONFIG,
): { keep: TrackPt[]; state: TrackState } {
  if (!state) return { keep: [p], state: { kept: p, held: null } };
  const keep: TrackPt[] = [];
  let kept = state.kept;
  const held = state.held;
  if (held && isTurn(kept, held, p, cfg)) {
    keep.push(held);
    kept = held;
  }
  if (haversineM(kept, p) >= cfg.minGapM || p.at - kept.at >= cfg.maxGapMs) {
    keep.push(p);
    return { keep, state: { kept: p, held: null } };
  }
  return { keep, state: { kept, held: p } };
}

/** The trip is over: its last position, still held back, is kept too (the route reaches the drop-off). */
export function endTrack(state: TrackState | null | undefined): TrackPt[] {
  return state?.held ? [state.held] : [];
}

function isTurn(a: LatLng, b: LatLng, c: LatLng, cfg: TrackConfig): boolean {
  if (haversineM(a, b) < cfg.turnMinLegM || haversineM(b, c) < cfg.turnMinLegM) return false;
  const d = Math.abs(bearingDeg(a, b) - bearingDeg(b, c)) % 360;
  return Math.min(d, 360 - d) >= cfg.turnDeg;
}
