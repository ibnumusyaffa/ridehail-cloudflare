/**
 * Watch a full ride happen: opens two Chromium windows side by side
 * (customer left, driver right) and drives both through the UI, slowly.
 *
 *   pnpm dev            # in another terminal: API :8787 + customer :5173 + driver :5174
 *   pnpm demo:live      # or demo:record → videos in apps/e2e/videos
 *
 * You can click in either window while it runs. After the script, windows stay open
 * (Ctrl+C to quit). Options: --trip <presetId>, --speed <m/s, default 12>, --slowmo <ms, default 700>,
 * --pace <pause multiplier, default 2>, --record (saves videos, then exits).
 */
import { chromium, type Page } from "@playwright/test";
import {
  customerOrder, driverAcceptOffer, driverOnlineNear, driverReachTarget, login, phone, rideStatus, topup, URLS,
} from "./steps";
import { expect } from "@playwright/test";

const record = process.argv.includes("--record");
const hold = process.argv.includes("--hold") || !record;
const presetIdx = process.argv.indexOf("--trip");
const trip = presetIdx > 0 ? process.argv[presetIdx + 1]! : "monas-hi";
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
/** driver autopilot m/s (12 ≈ 43 km/h, realistic city scooter) */
const SPEED = arg("speed", 12);
/** delay between every UI action, ms */
const SLOWMO = arg("slowmo", 700);
/** multiplier for the narrative pauses */
const PACE = arg("pace", 2);
const W = 720;
const H = 900;

const say = (s: string) => console.log(`\n▶ ${s}`);
const pause = (ms = 1200) => new Promise((r) => setTimeout(r, ms * PACE));

async function open(x: number, label: string) {
  const browser = await chromium.launch({
    headless: false,
    slowMo: SLOWMO,
    args: [`--window-position=${x},0`, `--window-size=${W},${H}`],
  });
  const ctx = await browser.newContext({
    viewport: null,
    ...(record ? { recordVideo: { dir: `videos/${label}`, size: { width: W, height: H - 80 } } } : {}),
  });
  await ctx.addInitScript((s) => localStorage.setItem("speed", localStorage.getItem("speed") ?? String(s)), SPEED);
  return { browser, page: await ctx.newPage() };
}

async function banner(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-banner";
      el.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:99;background:#111827cc;color:#fff;font:600 14px system-ui;padding:6px 12px;text-align:center;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

const c = await open(0, "customer");
const d = await open(W + 10, "driver");
const customer = c.page;
const driver = d.page;
const both = (t: string) => Promise.all([banner(customer, t), banner(driver, t)]);

try {
  say("Login");
  await Promise.all([
    login(customer, URLS.customer, { phone: phone("0812"), name: "Siti (customer)" }),
    login(driver, URLS.driver, { phone: phone("0899"), name: "Budi (driver)" }),
  ]);

  say("Customer tops up wallet");
  await both("Customer tops up the wallet: Rp100,000");
  await topup(customer, 100_000);
  await pause();

  say("Driver goes online near the pickup");
  await both("Driver goes online near the pickup");
  await driverOnlineNear(driver, trip);
  await pause();

  say("Customer orders a ride (wallet)");
  await both("Customer picks a route and orders (paid by wallet)");
  await customerOrder(customer, trip, "WALLET");
  await pause(2500);

  say("Driver gets the offer and accepts");
  await both("Driver gets an offer (15 s) → Accept");
  await expect(driver.getByTestId("offer")).toBeVisible({ timeout: 15_000 });
  await pause(3000);
  await driverAcceptOffer(driver);

  say("Driver drives to pickup (autopilot) — watch the marker on the customer map");
  await both("Driver heads to the pickup: watch 🛵 move on the customer's map");
  await driverReachTarget(driver, 15 * 60_000);
  await driver.getByTestId("ride-arrived").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ARRIVED");
  await both("Driver arrives → starts the trip");
  await pause(2500);
  await driver.getByTestId("ride-start").click();

  say("On trip");
  await both("On the way to the destination");
  await driverReachTarget(driver, 15 * 60_000);
  await driver.getByTestId("ride-complete").click();
  await expect(customer.getByTestId("paid-summary")).toHaveAttribute("data-paid-via", "WALLET");

  say("Completed & paid — customer rates 5 stars");
  await both("Done: customer charged, driver earns the fare minus commission");
  await pause(2500);
  await customer.getByTestId("star-5").click();
  await customer.getByTestId("tab-wallet").click();
  await driver.getByTestId("tab-wallet").click();
  await both("Both wallets");
  await pause(4000);
  say("Done.");
} catch (e) {
  console.error("demo failed:", e);
} finally {
  if (hold) {
    console.log("\nWindows stay open — interact freely. Ctrl+C to quit.");
    await new Promise(() => {});
  }
  await customer.context().close();
  await driver.context().close();
  await c.browser.close();
  await d.browser.close();
  if (record) console.log("videos saved in apps/e2e/videos/");
}
