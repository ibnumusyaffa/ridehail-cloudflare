import { haversineM } from "./geo";
import type { LatLng } from "./types";

export interface FareConfig {
  baseFare: number; // rupiah
  perKm: number; // rupiah per km
  minFare: number; // rupiah
  roundTo: number; // rupiah, e.g. 500
  distanceFactor: number; // haversine -> road distance estimate, e.g. 1.3
}

export const DEFAULT_FARE_CONFIG: FareConfig = {
  baseFare: 5_000,
  perKm: 2_500,
  minFare: 10_000,
  roundTo: 500,
  distanceFactor: 1.3,
};

export function estimateDistanceM(a: LatLng, b: LatLng, cfg: FareConfig = DEFAULT_FARE_CONFIG): number {
  return Math.round(haversineM(a, b) * cfg.distanceFactor);
}

/** fare = max(MIN_FARE, BASE + PER_KM * km), rounded UP to `roundTo`. Integer rupiah. */
export function computeFare(distanceM: number, cfg: FareConfig = DEFAULT_FARE_CONFIG): number {
  const raw = Math.max(cfg.minFare, cfg.baseFare + (cfg.perKm * distanceM) / 1000);
  return Math.ceil(raw / cfg.roundTo) * cfg.roundTo;
}

export function estimate(pickup: LatLng, dropoff: LatLng, cfg: FareConfig = DEFAULT_FARE_CONFIG) {
  const distanceM = estimateDistanceM(pickup, dropoff, cfg);
  return { distanceM, fare: computeFare(distanceM, cfg) };
}
