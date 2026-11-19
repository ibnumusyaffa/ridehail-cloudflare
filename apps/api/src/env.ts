import { DEFAULT_PRESENCE_CONFIG, DEFAULT_TRACK_CONFIG } from "@gojek/core";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Every string var/secret the Worker reads (wrangler.jsonc `vars`, `.dev.vars`, `wrangler secret`),
// validated once per env object. A bad value fails loudly instead of silently falling back to a default.
// Bindings (HYPERDRIVE, MATCH, RIDE, *_LIMITER) are not strings and stay on `Env`.

/** Durable Object location hints (https://developers.cloudflare.com/durable-objects/reference/data-location/) */
export const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const;

const int = (d: number) => z.coerce.number().int().default(d);
const nonNeg = (d: number) => z.coerce.number().int().min(0).default(d);

function parse(runtimeEnv: Env) {
  return createEnv({
    server: {
      JWT_SECRET: z.string().min(1, "JWT_SECRET is not configured (`wrangler secret put JWT_SECRET`, local: .dev.vars)"),
      /** "1" enables POST /dev/reset (wipes all data): local dev and tests only */
      DEV_RESET: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
      /** "*" or a comma-separated list of allowed origins */
      CORS_ORIGINS: z
        .string()
        .default("*")
        .transform((v) => (v.trim() === "*" ? "*" : v.split(",").map((s) => s.trim()).filter(Boolean))),
      /** empty = nearest to the first request */
      DO_LOCATION_HINT: z.enum(LOCATION_HINTS).optional(),
      ZONE_PRECISION: z.coerce.number().int().min(1).max(12).default(5),
      /** "1", "4", or "qqguw=8,qqgux=4,*=1" (parsed by `parseRideShards`) */
      RIDE_SHARDS: z.string().default("1"),
      COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.2),
      DRIVER_MIN_BALANCE: int(-50_000),
      OFFER_TIMEOUT_MS: nonNeg(15_000),
      RESERVE_TTL_MS: nonNeg(20_000),
      SEARCH_TIMEOUT_MS: nonNeg(120_000),
      RESEARCH_DELAY_MS: nonNeg(5_000),
      TOPUP_MAX: z.coerce.number().int().positive().default(1_000_000),
      MAX_REQUEUES: nonNeg(3),
      DRIVER_LOST_ASK_MS: nonNeg(60 * 60_000),
      DRIVER_LOST_CANCEL_MS: nonNeg(3 * 60 * 60_000),
      TRACK_FLUSH_MS: nonNeg(60_000),
      TRACK_MIN_GAP_M: nonNeg(DEFAULT_TRACK_CONFIG.minGapM),
      TRACK_MAX_GAP_MS: nonNeg(DEFAULT_TRACK_CONFIG.maxGapMs),
      TRACK_TOLERANCE_M: nonNeg(DEFAULT_TRACK_CONFIG.toleranceM),
      LOC_MIN_INTERVAL_MS: nonNeg(DEFAULT_PRESENCE_CONFIG.locMinIntervalMs),
      LOC_MIN_INTERVAL_ON_RIDE_MS: nonNeg(DEFAULT_PRESENCE_CONFIG.locMinIntervalOnRideMs),
      LOC_MIN_MOVE_M: nonNeg(DEFAULT_PRESENCE_CONFIG.locMinMoveM),
      HANDOFF_MARGIN_M: nonNeg(DEFAULT_PRESENCE_CONFIG.handoffMarginM),
      /** a driver can mark "arrived" only this close to the pickup (metres, straight line); 0 = no check */
      ARRIVE_MAX_DISTANCE_M: nonNeg(200),
      /** a driver can complete a trip only this close to the dropoff (metres, straight line); 0 = no check */
      COMPLETE_MAX_DISTANCE_M: nonNeg(300),
      HANDOFF_PINGS: z.coerce.number().int().min(1).default(DEFAULT_PRESENCE_CONFIG.handoffPings),
    },
    runtimeEnv: runtimeEnv as unknown as Record<string, string | undefined>,
    isServer: true,
    emptyStringAsUndefined: true,
  });
}

export type ServerEnv = ReturnType<typeof parse>;

// Workers hand the same env object to every request of an isolate (and to each actor's constructor).
const cache = new WeakMap<object, ServerEnv>();

export function serverEnv(env: Env): ServerEnv {
  let e = cache.get(env);
  if (!e) cache.set(env, (e = parse(env)));
  return e;
}
