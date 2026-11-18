import {
  DEFAULT_FARE_CONFIG,
  DEFAULT_MATCH_CONFIG,
  type FareConfig,
  isGeohash,
  type MatchConfig,
  type PresenceConfig,
  type TrackConfig,
} from "@gojek/core";
import { serverEnv } from "./env";

export interface Config {
  zonePrecision: number;
  commissionRate: number;
  driverMinBalance: number;
  offerTimeoutMs: number;
  reserveTtlMs: number;
  searchTimeoutMs: number;
  researchDelayMs: number;
  /** a driver dropping an accepted ride sends it back to the search, at most this many times per ride */
  maxRequeues: number;
  topupMax: number;
  /** ON_TRIP without a driver location ping this long → ask the customer (and again every interval) */
  driverLostAskMs: number;
  /** ON_TRIP without a driver location ping this long → the system cancels the ride */
  driverLostCancelMs: number;
  /** ON_TRIP route points buffered in the zone actor are sent to Postgres this often */
  trackFlushMs: number;
  /** which ON_TRIP pings are kept as the trip's route (see `sampleTrack`) */
  track: TrackConfig;
  /** ride actors per zone (see `rideHome`) */
  rideShards: RideShards;
  fare: FareConfig;
  match: MatchConfig;
  presence: PresenceConfig;
}

export function loadConfig(env: Env): Config {
  const e = serverEnv(env);
  const match = DEFAULT_MATCH_CONFIG;
  const minRing = Math.min(...match.ringPrecisions);
  return {
    // a zone must fully contain each search cell, so zone precision <= smallest ring precision
    zonePrecision: Math.min(minRing, e.ZONE_PRECISION),
    commissionRate: e.COMMISSION_RATE,
    driverMinBalance: e.DRIVER_MIN_BALANCE,
    offerTimeoutMs: e.OFFER_TIMEOUT_MS,
    reserveTtlMs: e.RESERVE_TTL_MS,
    searchTimeoutMs: e.SEARCH_TIMEOUT_MS,
    researchDelayMs: e.RESEARCH_DELAY_MS,
    maxRequeues: e.MAX_REQUEUES,
    topupMax: e.TOPUP_MAX,
    driverLostAskMs: e.DRIVER_LOST_ASK_MS,
    driverLostCancelMs: e.DRIVER_LOST_CANCEL_MS,
    trackFlushMs: e.TRACK_FLUSH_MS,
    track: { minGapM: e.TRACK_MIN_GAP_M, maxGapMs: e.TRACK_MAX_GAP_MS, toleranceM: e.TRACK_TOLERANCE_M },
    rideShards: parseRideShards(e.RIDE_SHARDS),
    fare: DEFAULT_FARE_CONFIG,
    match,
    presence: {
      locMinIntervalMs: e.LOC_MIN_INTERVAL_MS,
      locMinIntervalOnRideMs: e.LOC_MIN_INTERVAL_ON_RIDE_MS,
      locMinMoveM: e.LOC_MIN_MOVE_M,
      handoffMarginM: e.HANDOFF_MARGIN_M,
      handoffPings: e.HANDOFF_PINGS,
    },
  };
}

// ------------------------------------------------------------- ride actor shards
//
// A busy zone's rides are spread over several ride actors (shards). A ride actor is named by its
// "home": the zone for shard 0, `<zone>.<k>` for shard k ≥ 1. A ride id starts with its home
// (`<home>_<uuid>`), so anyone can route to a ride's actor without a lookup, and changing a zone's
// shard count never moves a ride already running (old ids `<zone>_<uuid>` are shard 0).

/** Hard upper bound on shards per zone (also bounds which actor names a client can make us create). */
export const MAX_RIDE_SHARDS = 64;
const SHARD_SEP = ".";

/**
 * `RIDE_SHARDS`: "4" (every zone), or per zone with a default: "qqguw=8,qqgux=4,*=1".
 * Unknown / invalid entries are ignored; counts are clamped to 1..MAX_RIDE_SHARDS.
 */
export function parseRideShards(v: unknown): RideShards {
  const out: RideShards = { default: 1, byZone: {} };
  if (typeof v !== "string") return out;
  const clamp = (n: number) => Math.max(1, Math.min(MAX_RIDE_SHARDS, Math.floor(n)));
  for (const part of v.split(",")) {
    const [k, n] = part.includes("=") ? part.split("=").map((s) => s.trim()) : ["*", part.trim()];
    const count = Number(n);
    if (!k || !Number.isFinite(count) || count < 1) continue;
    if (k === "*") out.default = clamp(count);
    else if (isGeohash(k)) out.byZone[k] = clamp(count);
  }
  return out;
}

export interface RideShards {
  default: number;
  byZone: Record<string, number>;
}

export const shardCount = (cfg: Config, zone: string) => cfg.rideShards.byZone[zone] ?? cfg.rideShards.default;

/** The shard of a customer's rides: stable while the count is unchanged, so a retried order lands on the same actor. */
export function shardFor(customerId: string, count: number): number {
  if (count <= 1) return 0;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < customerId.length; i++) h = Math.imul(h ^ customerId.charCodeAt(i), 0x01000193);
  return (h >>> 0) % count;
}

export const rideHome = (zone: string, shard: number) => (shard > 0 ? `${zone}${SHARD_SEP}${shard}` : zone);

/** `<zone>` / `<zone>.<k>` → its parts; null unless canonical (k in 1..MAX-1, no leading zero). */
export function parseRideHome(home: string): { zone: string; shard: number } | null {
  const i = home.indexOf(SHARD_SEP);
  const zone = i < 0 ? home : home.slice(0, i);
  if (!isGeohash(zone)) return null;
  if (i < 0) return { zone, shard: 0 };
  const k = home.slice(i + 1);
  if (!/^[1-9]\d*$/.test(k) || Number(k) >= MAX_RIDE_SHARDS) return null;
  return { zone, shard: Number(k) };
}

/** Ride ids embed the owning ride actor: `<home>_<uuid>`. Null when the prefix is not a valid home. */
export function homeOfRide(rideId: string): string | null {
  const i = rideId.indexOf("_");
  if (i <= 0) return null;
  const home = rideId.slice(0, i);
  return parseRideHome(home) ? home : null;
}



/** A zone has a match actor `match:<zone>` (free drivers, search) and ride actors `ride:<home>` (its rides). */
export type ActorKind = "match" | "ride";

export const actorName = (kind: ActorKind, key: string) => `${kind}:${key}`;

/** An actor's key, from its name: the zone (`match:<zone>`) or the ride home (`ride:<zone>[.<k>]`). */
export function keyOfActor(name: string | undefined): string | null {
  if (!name) return null;
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : null;
}

/** The geohash zone of an actor key (a ride home loses its shard). */
export const zoneOfKey = (key: string) => parseRideHome(key)?.zone ?? key;

/**
 * An actor's stub. `DO_LOCATION_HINT` places new actors near the Postgres region (every ride
 * transition waits on Postgres); it only applies when an actor is first created, never moves one.
 */
function stubOf(ns: DurableObjectNamespace, env: Env, name: string): DurableObjectStub {
  const id = ns.idFromName(name);
  const hint = serverEnv(env).DO_LOCATION_HINT;
  return hint ? ns.get(id, { locationHint: hint }) : ns.get(id);
}

export function matchStub(env: Env, zone: string): DurableObjectStub {
  return stubOf(env.MATCH as unknown as DurableObjectNamespace, env, actorName("match", zone));
}

/** The ride actor of `home` (a zone, or `<zone>.<k>` for shard k: see `rideHome`). */
export function rideStub(env: Env, home: string): DurableObjectStub {
  return stubOf(env.RIDE as unknown as DurableObjectNamespace, env, actorName("ride", home));
}
