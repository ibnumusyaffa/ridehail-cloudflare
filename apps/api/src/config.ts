import {
  DEFAULT_FARE_CONFIG,
  DEFAULT_MATCH_CONFIG,
  DEFAULT_PRESENCE_CONFIG,
  type FareConfig,
  type MatchConfig,
  type PresenceConfig,
} from "@gojek/core";

export interface Config {
  zonePrecision: number;
  commissionRate: number;
  driverMinBalance: number;
  offerTimeoutMs: number;
  reserveTtlMs: number;
  searchTimeoutMs: number;
  researchDelayMs: number;
  topupMax: number;
  fare: FareConfig;
  match: MatchConfig;
  presence: PresenceConfig;
}

const num = (v: unknown, d: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env: Env): Config {
  const match = DEFAULT_MATCH_CONFIG;
  const minRing = Math.min(...match.ringPrecisions);
  return {
    // a zone must fully contain each search cell, so zone precision <= smallest ring precision
    zonePrecision: Math.max(1, Math.min(minRing, num(env.ZONE_PRECISION, 5))),
    commissionRate: num(env.COMMISSION_RATE, 0.2),
    driverMinBalance: num(env.DRIVER_MIN_BALANCE, -50_000),
    offerTimeoutMs: num(env.OFFER_TIMEOUT_MS, 15_000),
    reserveTtlMs: num(env.RESERVE_TTL_MS, 20_000),
    searchTimeoutMs: num(env.SEARCH_TIMEOUT_MS, 120_000),
    researchDelayMs: num(env.RESEARCH_DELAY_MS, 5_000),
    topupMax: num(env.TOPUP_MAX, 1_000_000),
    fare: DEFAULT_FARE_CONFIG,
    match,
    presence: {
      locMinIntervalMs: num(env.LOC_MIN_INTERVAL_MS, DEFAULT_PRESENCE_CONFIG.locMinIntervalMs),
      locMinIntervalOnRideMs: num(env.LOC_MIN_INTERVAL_ON_RIDE_MS, DEFAULT_PRESENCE_CONFIG.locMinIntervalOnRideMs),
      locMinMoveM: num(env.LOC_MIN_MOVE_M, DEFAULT_PRESENCE_CONFIG.locMinMoveM),
      handoffMarginM: num(env.HANDOFF_MARGIN_M, DEFAULT_PRESENCE_CONFIG.handoffMarginM),
      handoffPings: num(env.HANDOFF_PINGS, DEFAULT_PRESENCE_CONFIG.handoffPings),
    },
  };
}

/** Ride ids embed the owning zone: `<zone>_<uuid>`. */
export function zoneOfRide(rideId: string): string | null {
  const i = rideId.indexOf("_");
  return i > 0 ? rideId.slice(0, i) : null;
}
