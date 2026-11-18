// UI steps shared by the Playwright tests and the live demo script.
import { expect, type Page } from "@playwright/test";

export const URLS = {
  customer: process.env.CUSTOMER_URL ?? "http://localhost:5173",
  driver: process.env.DRIVER_URL ?? "http://localhost:5174",
  api: process.env.API_URL ?? "http://localhost:8787",
};

/**
 * The next `count` POSTs to `path` reach the API and are processed there, but the browser never gets the
 * reply (as if the connection dropped on the way back). Returns how many POSTs were sent in total.
 */
export async function loseReplies(page: Page, path: string, count: number): Promise<{ posts: () => number }> {
  let posts = 0;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      if (posts > count) return route.continue();
      await route.fetch(); // the server does the work...
      await route.abort("connectionreset"); // ...the reply is lost
    },
  );
  return { posts: () => posts };
}

/** GET an API path as the page's logged-in user. */
export async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    async ({ base, path }) => {
      const { token } = JSON.parse(localStorage.getItem("session") ?? "{}");
      const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
      return res.json();
    },
    { base: URLS.api, path },
  );
}

let n = 0;
export const phone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${++n}`;

export async function login(page: Page, url: string, opts: { phone: string; name: string }) {
  await page.goto(url);
  await page.getByTestId("login-phone").fill(opts.phone);
  await page.getByTestId("login-name").fill(opts.name);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-submit")).toBeHidden();
}

export async function driverOnlineNear(driver: Page, presetId: string) {
  await driver.getByTestId("spawn").selectOption(presetId);
  await driver.getByTestId("online-toggle").click();
  await expect(driver.getByTestId("driver-status")).toHaveAttribute("data-status", "AVAILABLE");
}

export async function topup(page: Page, amount: 50_000 | 100_000) {
  await page.getByTestId("tab-wallet").click();
  const before = await page.getByTestId("wallet-balance").textContent();
  await page.getByTestId(`topup-${amount}`).click();
  await expect(page.getByTestId("wallet-balance")).not.toHaveText(before ?? "");
}

export async function customerOrder(customer: Page, presetId: string, pay: "CASH" | "WALLET") {
  await customer.getByTestId("tab-ride").click();
  await customer.getByTestId("preset").selectOption(presetId);
  await expect(customer.getByTestId("fare")).toBeVisible();
  await customer.getByTestId(`pay-${pay}`).click();
  await customer.getByTestId("order-button").click();
}

export const rideStatus = (customer: Page) => customer.getByTestId("ride-status");

export async function driverAcceptOffer(driver: Page) {
  await expect(driver.getByTestId("offer")).toBeVisible({ timeout: 15_000 });
  await driver.getByTestId("offer-accept").click();
  await expect(driver.getByTestId("driver-ride-status")).toHaveAttribute("data-status", "ACCEPTED");
}

/** Wait until autopilot reaches the current target (pickup or dropoff). */
export async function driverReachTarget(driver: Page, timeout = 60_000) {
  await expect(driver.getByTestId("nav")).toHaveAttribute("data-at-target", "true", { timeout });
}

export async function driverCompleteTrip(driver: Page, customer: Page) {
  await driverReachTarget(driver);
  await driver.getByTestId("ride-arrived").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ARRIVED");
  await driver.getByTestId("ride-start").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ON_TRIP");
  await driverReachTarget(driver);
  await driver.getByTestId("ride-complete").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "COMPLETED");
}
