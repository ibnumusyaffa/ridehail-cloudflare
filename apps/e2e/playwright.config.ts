import { defineConfig, devices } from "@playwright/test";

// Isolated stack on its own ports with a fresh Postgres database (gojek_e2e) and DO state for every run.
// Needs the local Postgres from `pnpm db:up`.
const API_PORT = 8788;
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/gojek_e2e";
const api = `http://localhost:${API_PORT}`;
process.env.CUSTOMER_URL ??= "http://localhost:5273";
process.env.DRIVER_URL ??= "http://localhost:5274";

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
  },
  webServer: [
    {
      command: `rm -rf .wrangler/e2e && node scripts/migrate.mjs --reset ${E2E_DATABASE_URL} && pnpm exec wrangler dev --port ${API_PORT} --persist-to .wrangler/e2e`,
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
      env: { VITE_API_URL: api, VITE_OSRM_URL: "off" }, // deterministic: no external routing
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec vite --port 5274 --strictPort",
      cwd: "../simulator-driver",
      url: process.env.DRIVER_URL,
      env: { VITE_API_URL: api, VITE_OSRM_URL: "off" }, // deterministic: no external routing
      reuseExistingServer: false,
    },
  ],
});
