import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Postgres from `pnpm db:up` (docker compose); test/global-setup.ts recreates the schema per run.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/gojek_test";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        hyperdrives: { HYPERDRIVE: TEST_DATABASE_URL },
        // tests log in hundreds of users from one "IP"
        ratelimits: {
          LOGIN_LIMITER: { namespace_id: "1001", simple: { limit: 100_000, period: 60 } },
          WS_LIMITER: { namespace_id: "1002", simple: { limit: 100_000, period: 60 } },
        },
        bindings: {
          JWT_SECRET: "test-secret",
          DEV_RESET: "1",
          // fast timers for tests
          OFFER_TIMEOUT_MS: "1500",
          RESERVE_TTL_MS: "2000",
          RESEARCH_DELAY_MS: "300",
          // a search with nobody around ends at this deadline (120 s by default)
          SEARCH_TIMEOUT_MS: "3000",
          // tests send pings back to back; the throttle itself is unit-tested in @gojek/core
          LOC_MIN_INTERVAL_MS: "0",
          LOC_MIN_INTERVAL_ON_RIDE_MS: "0",
        },
      },
    }),
  ],
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // one shared database: reset.test.ts wipes it, so test files must not run concurrently
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
