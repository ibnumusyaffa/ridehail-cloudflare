import { distanceInsideCellM, haversineM } from "./geo";
import type { LatLng } from "./types";

export interface PresenceConfig {
  /**
   * Minimum gap between accepted location pings of a driver not on a ride (available / reserved /
   * offline). A driver standing still is then processed only this often: a heartbeat well inside the
   * matcher's `staleMs` (45 s). Keep it below the client's idle interval (`shouldSendPing`) so network jitter
   * never drops a heartbeat.
   */
  locMinIntervalMs: number;
  /** Same, for a driver on a ride (the customer watches the marker, so allow more). */
  locMinIntervalOnRideMs: number;
  /** A ping that moved at least this far is always accepted (a jump must never be dropped). */
  locMinMoveM: number;
  /** A driver is handed to a new zone once this deep inside it… */
  handoffMarginM: number;
  /** …or after this many consecutive pings outside the current zone. */
  handoffPings: number;
}

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  locMinIntervalMs: 8_000,
  locMinIntervalOnRideMs: 1_000,
  locMinMoveM: 30,
  handoffMarginM: 100,
  handoffPings: 3,
};

/**
 * Server-side throttle: drop a ping that arrives too soon after the previous accepted one
 * *and* barely moved (GPS jitter / chatty clients). A real move is always kept.
 */
export function acceptPing(
  prev: (LatLng & { at: number }) | null,
  next: LatLng & { at: number },
  onRide: boolean,
  cfg: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): boolean {
  if (!prev) return true;
  if (next.at - prev.at >= (onRide ? cfg.locMinIntervalOnRideMs : cfg.locMinIntervalMs)) return true;
  return haversineM(prev, next) >= cfg.locMinMoveM;
}

/**
 * Zone hysteresis: hand a driver over to `newZone` only when clearly inside it, or after it has
 * stayed outside the current zone for several pings — so GPS jitter on a border doesn't cause
 * a reconnect loop. `outsidePings` counts consecutive pings outside the current zone (incl. this one).
 */
export function shouldHandOff(p: LatLng, newZone: string, outsidePings: number, cfg: PresenceConfig = DEFAULT_PRESENCE_CONFIG): boolean {
  return distanceInsideCellM(p, newZone) >= cfg.handoffMarginM || outsidePings >= cfg.handoffPings;
}

/**
 * Client-side throttle: send a location ping only after moving far enough or waiting long enough.
 * Keeps idle drivers at one ping per `maxIntervalMs` (above the server's `locMinIntervalMs`, so each is a heartbeat it keeps).
 */
export function shouldSendPing(
  last: (LatLng & { at: number }) | null,
  now: LatLng & { at: number },
  movedM: (a: LatLng, b: LatLng) => number,
  opts: { minMoveM: number; maxIntervalMs: number } = { minMoveM: 30, maxIntervalMs: 10_000 },
): boolean {
  if (!last) return true;
  return now.at - last.at >= opts.maxIntervalMs || movedM(last, now) >= opts.minMoveM;
}
