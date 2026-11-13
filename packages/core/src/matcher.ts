import { geohashEncode, geohashNeighborhood, haversineM } from "./geo";
import type { DriverStatus, LatLng } from "./types";

export interface DriverSnapshot extends LatLng {
  id: string;
  status: DriverStatus;
  updatedAt: number;
  /** Reservation expiry; a RESERVED driver whose reservation lapsed counts as AVAILABLE. */
  reservedUntil?: number | null;
}

export interface Candidate {
  driverId: string;
  distanceM: number;
}

export interface MatchConfig {
  staleMs: number; // driver ignored if no ping for longer than this
  maxRadiusM: number;
  k: number;
  /** Geohash precisions searched in order: each ring = cell + 8 neighbours at that precision. */
  ringPrecisions: number[];
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  staleMs: 30_000,
  maxRadiusM: 5_000,
  k: 10,
  ringPrecisions: [6, 5],
};

export function isDispatchable(d: DriverSnapshot, now: number, cfg: MatchConfig = DEFAULT_MATCH_CONFIG): boolean {
  if (now - d.updatedAt > cfg.staleMs) return false;
  if (d.status === "AVAILABLE") return true;
  return d.status === "RESERVED" && d.reservedUntil != null && d.reservedUntil < now;
}

/** Cells to search for ring `i` around `pickup`. */
export function searchCells(pickup: LatLng, precision: number): string[] {
  return geohashNeighborhood(geohashEncode(pickup.lat, pickup.lng, precision));
}

/**
 * Rank drivers for a pickup: dispatchable, not excluded, within max radius,
 * nearest first, top k. Pure — callers feed it drivers from whatever store.
 */
export function rankCandidates(
  pickup: LatLng,
  drivers: Iterable<DriverSnapshot>,
  opts: { now: number; exclude?: ReadonlySet<string>; cfg?: MatchConfig },
): Candidate[] {
  const cfg = opts.cfg ?? DEFAULT_MATCH_CONFIG;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const d of drivers) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    if (opts.exclude?.has(d.id)) continue;
    if (!isDispatchable(d, opts.now, cfg)) continue;
    const distanceM = haversineM(pickup, d);
    if (distanceM > cfg.maxRadiusM) continue;
    out.push({ driverId: d.id, distanceM: Math.round(distanceM) });
  }
  out.sort((a, b) => a.distanceM - b.distanceM || a.driverId.localeCompare(b.driverId));
  return out.slice(0, cfg.k);
}
