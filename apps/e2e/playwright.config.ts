import { defineConfig, devices } from "@playwright/test";

// Isolated stack on its own ports with a fresh Postgres database (gojek_e2e) and DO state for every run.
// Needs the local Postgres from `pnpm db:up`.
const API_PORT = 8788;
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/gojek_e2e";
const api = `http://localhost:${API_PORT}`;
// search gives up (NO_DRIVER) after SEARCH_TIMEOUT_MS, re-searching every RESEARCH_DELAY_MS; the
// production 120 s / 5 s is too slow for a test that waits for NO_DRIVER
const API_VARS = "--var SEARCH_TIMEOUT_MS:8000 --var RESEARCH_DELAY_MS:1000";
process.env.CUSTOMER_URL ??= "http://localhost:5273";
process.env.DRIVER_URL ??= "http://localhost:5274";
process.env.API_URL ??= api;

export default defineConfig({
  testDir: "tests",
  workers: 1, // tests share one city (one API)
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 720, height: 860 },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // watch it: SLOWMO=600 pnpm e2e:headed (ms between browser actions)
    launchOptions: { slowMo: Number(process.env.SLOWMO ?? 0) },
  },
  webServer: [
    {
      command: `rm -rf .wrangler/e2e && node scripts/migrate.mjs --reset ${E2E_DATABASE_URL} && pnpm exec wrangler dev --port ${API_PORT} --persist-to .wrangler/e2e ${API_VARS}`,
      cwd: "../api",
      env: { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: E2E_DATABASE_URL },
      url: `${api}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm exec vite --port 5273 --strictPort",
      cwd: "../simulator-customer",
      url: process.env.CUSTOMER_URL,
      env: { VITE_API_URL: api, VITE_GEOCODER_URL: "off" }, // road routes via OSRM (straight-line fallback if it fails); no geocoder
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec vite --port 5274 --strictPort",
      cwd: "../simulator-driver",
      url: process.env.DRIVER_URL,
      env: { VITE_API_URL: api, VITE_GEOCODER_URL: "off" }, // road routes via OSRM (straight-line fallback if it fails); no geocoder
      reuseExistingServer: false,
    },
  ],
});
