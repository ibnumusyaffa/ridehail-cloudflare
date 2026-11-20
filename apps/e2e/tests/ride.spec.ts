import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  apiGet, customerOrder, driverAcceptOffer, driverCompleteTrip, driverOnlineNear, driverReachTarget, login, loseReplies, phone,
  rideStatus, topup, URLS,
} from "../src/steps";

async function pair(browser: Browser, speed = 120): Promise<{ customer: Page; driver: Page }> {
  const [cc, dc] = await Promise.all([browser.newContext(), browser.newContext()]);
  // fast autopilot for tests
  await dc.addInitScript((s) => localStorage.setItem("speed", String(s)), speed);
  const [customer, driver] = await Promise.all([cc.newPage(), dc.newPage()]);
  await login(customer, URLS.customer, { phone: phone("0812"), name: "Siti" });
  await login(driver, URLS.driver, { phone: phone("0899"), name: "Pak Budi" });
  return { customer, driver };
}

test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("full ride paid by wallet, both sides see payment", async ({ browser }) => {
  const { customer, driver } = await pair(browser);
  await topup(customer, 100_000);
  await driverOnlineNear(driver, "monas-hi");

  await customerOrder(customer, "monas-hi", "WALLET");
  await expect(rideStatus(customer)).toHaveAttribute("data-status", /REQUESTED|OFFERING/);
  await driverAcceptOffer(driver);

  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ACCEPTED");
  await expect(customer.getByTestId("driver-name")).toHaveText("Pak Budi");
  await expect(customer.getByTestId("marker-driver")).toBeVisible();

  await driverCompleteTrip(driver, customer);
  await expect(customer.getByTestId("paid-summary")).toHaveAttribute("data-paid-via", "WALLET");
  await expect(driver.getByTestId("last-paid")).toContainText("wallet");

  await customer.getByTestId("star-5").click();
  await customer.getByTestId("tab-history").click();
  await expect(customer.getByTestId("history")).toContainText("★★★★★");
  await driver.getByTestId("tab-earnings").click();
  await expect(driver.getByTestId("today-count")).toHaveText("1");
});

test("driver rejects → no other driver → NO_DRIVER", async ({ browser }) => {
  const { customer, driver } = await pair(browser);
  await driverOnlineNear(driver, "gbk-blokm");
  await customerOrder(customer, "gbk-blokm", "CASH");
  await expect(driver.getByTestId("offer")).toBeVisible();
  await driver.getByTestId("offer-reject").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "NO_DRIVER", { timeout: 15_000 });
  await expect(driver.getByTestId("driver-status")).toHaveAttribute("data-status", "AVAILABLE");
});

test("customer cancels while driver is being offered", async ({ browser }) => {
  const { customer, driver } = await pair(browser);
  await driverOnlineNear(driver, "kota-ancol");
  await customerOrder(customer, "kota-ancol", "CASH");
  await expect(driver.getByTestId("offer")).toBeVisible();
  await customer.getByTestId("cancel-button").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "CANCELLED");
  await expect(driver.getByTestId("offer")).toBeHidden();
  await expect(driver.getByTestId("toast")).toContainText("cancelled");
});

test("driver reloads mid-ride and resumes", async ({ browser }) => {
  const { customer, driver } = await pair(browser);
  await driverOnlineNear(driver, "kuningan-senopati");
  await customerOrder(customer, "kuningan-senopati", "CASH");
  await driverAcceptOffer(driver);
  await driverReachTarget(driver);
  await driver.getByTestId("ride-arrived").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ARRIVED");

  await driver.reload();
  await expect(driver.getByTestId("driver-ride-status")).toHaveAttribute("data-status", "ARRIVED");
  await driver.getByTestId("ride-start").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ON_TRIP");
  await driverReachTarget(driver);
  await driver.getByTestId("ride-complete").click();
  await expect(customer.getByTestId("paid-summary")).toHaveAttribute("data-paid-via", "CASH");
});

test("wallet order refused when balance is too low", async ({ browser }) => {
  const { customer } = await pair(browser);
  await customerOrder(customer, "monas-hi", "WALLET");
  await expect(customer.getByTestId("toast")).toContainText("balance 0");
  await expect(customer.getByTestId("order-card")).toBeVisible();
});

test("reset button wipes everything and logs the other window out", async ({ browser }) => {
  const { customer, driver } = await pair(browser);
  await driverOnlineNear(driver, "monas-hi");
  await customer.getByTestId("tab-account").click();
  customer.once("dialog", (d) => d.accept());
  await customer.getByTestId("reset-sim").click();
  // both apps land on the login screen with clean local state
  await expect(customer.getByTestId("login-phone")).toBeVisible();
  await expect(driver.getByTestId("login-phone")).toBeVisible({ timeout: 15_000 });
  expect(await driver.evaluate(() => localStorage.getItem("session"))).toBeNull();
});

test.describe("lost replies (outage on the way back)", () => {
  const myRides = async (p: Page) => (await apiGet<{ rides: unknown[] }>(p, "/rides?mine=1")).rides.length;

  test("order reply lost once → retried with the same key, one ride", async ({ browser }) => {
    const { customer } = await pair(browser);
    const net = await loseReplies(customer, "/rides", 1);
    await customerOrder(customer, "monas-hi", "CASH");
    await expect(rideStatus(customer)).toHaveAttribute("data-status", /REQUESTED|OFFERING|NO_DRIVER/);
    expect(net.posts()).toBe(2);
    expect(await myRides(customer)).toBe(1);
  });

  test("every retry lost, then a new order → the ride that went through is shown", async ({ browser }) => {
    const { customer } = await pair(browser);
    await loseReplies(customer, "/rides", 3);
    await customerOrder(customer, "monas-hi", "CASH");
    await expect(customer.getByTestId("order-card")).toBeVisible();
    await expect(customer.getByTestId("toast")).toBeVisible({ timeout: 10_000 });
    expect(await myRides(customer)).toBe(1);

    // a different trip gets a new key: the server refuses it (one active ride), the app shows the first one
    await customerOrder(customer, "gbk-blokm", "CASH");
    await expect(rideStatus(customer)).toHaveAttribute("data-status", /REQUESTED|OFFERING|NO_DRIVER/);
    await expect(customer.getByTestId("toast")).toContainText("already went through");
    expect(await myRides(customer)).toBe(1);
  });

  test("top-up reply lost → pressed again, credited once", async ({ browser }) => {
    const { customer } = await pair(browser);
    await loseReplies(customer, "/wallet/topup", 3);
    await customer.getByTestId("tab-wallet").click();
    await customer.getByTestId("topup-50000").click();
    await expect.poll(async () => (await apiGet<{ balance: number }>(customer, "/wallet")).balance).toBe(50_000);
    await customer.getByTestId("topup-50000").click(); // same key: the server answers with the first top-up
    await expect(customer.getByTestId("wallet-balance")).toContainText("50");
    expect((await apiGet<{ balance: number }>(customer, "/wallet")).balance).toBe(50_000);
    expect((await apiGet<{ transactions: unknown[] }>(customer, "/wallet/transactions")).transactions).toHaveLength(1);
  });
});
