import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_SECRET: "test-secret",
            DEV_RESET: "1",
            // fast timers for tests
            OFFER_TIMEOUT_MS: "1500",
            RESERVE_TTL_MS: "2000",
            RESEARCH_DELAY_MS: "300",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      testTimeout: 20_000,
    },
  };
});
