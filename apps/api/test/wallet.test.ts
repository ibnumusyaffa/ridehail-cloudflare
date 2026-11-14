import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { settleRide } from "../src/db";
import { api, login, withSql } from "./helpers";

async function ledgerInvariant(userId: string) {
  const [r] = await withSql(env, (sql) => sql`
    SELECT w.balance, COALESCE((SELECT SUM(amount) FROM wallet_transactions t WHERE t.user_id = w.user_id), 0)::int8 AS sum
    FROM wallets w WHERE user_id = ${userId}`);
  expect(r!.balance).toBe(r!.sum);
  return r!.balance as number;
}

async function insertRide(id: string, customerId: string, driverId: string, fare: number, method: "CASH" | "WALLET") {
  await withSql(env, (sql) => sql`
    INSERT INTO rides (id, customer_id, driver_id, pickup_lat, pickup_lng, drop_lat, drop_lng, status, fare_estimate, fare_final, distance_m, payment_method, requested_at)
    VALUES (${id}, ${customerId}, ${driverId}, -6.2, 106.8, -6.21, 106.81, 'COMPLETED', ${fare}, ${fare}, 1000, ${method}, ${Date.now()})`);
}

const settle = (args: Parameters<typeof settleRide>[1]) => withSql(env, (sql) => settleRide(sql, args));

describe("wallet", () => {
  it("top-up is idempotent per Idempotency-Key and validated", async () => {
    const c = await login("customer");
    const t1 = await api("/wallet/topup", { token: c.token, body: { amount: 50_000 }, headers: { "Idempotency-Key": "k1" } });
    const t2 = await api("/wallet/topup", { token: c.token, body: { amount: 50_000 }, headers: { "Idempotency-Key": "k1" } });
    const t3 = await api("/wallet/topup", { token: c.token, body: { amount: 25_000 }, headers: { "Idempotency-Key": "k2" } });
    expect(t1.json.balance).toBe(50_000);
    expect(t2.json.balance).toBe(50_000);
    expect(t3.json.balance).toBe(75_000);
    expect((await api("/wallet/topup", { token: c.token, body: { amount: 5_000_000 }, headers: { "Idempotency-Key": "k3" } })).status).toBe(400);
    expect((await api("/wallet/topup", { token: c.token, body: { amount: 100 } })).status).toBe(400);
    const txs = await api("/wallet/transactions", { token: c.token });
    expect(txs.json.transactions).toHaveLength(2);
    await ledgerInvariant(c.id);
  });

  it("wallet settlement pays driver net of commission, and never twice", async () => {
    const c = await login("customer");
    const d = await login("driver");
    await api("/wallet/topup", { token: c.token, body: { amount: 100_000 }, headers: { "Idempotency-Key": "a" } });
    await insertRide("qqguv_w1", c.id, d.id, 20_000, "WALLET");
    const args = { rideId: "qqguv_w1", customerId: c.id, driverId: d.id, fare: 20_000, paymentMethod: "WALLET" as const, commissionRate: 0.2 };
    const r1 = await settle(args);
    const r2 = await settle(args);
    expect(r1).toEqual({ paidVia: "WALLET", customerBalance: 80_000, driverBalance: 16_000 });
    expect(r2).toEqual(r1);
    expect(await ledgerInvariant(c.id)).toBe(80_000);
    expect(await ledgerInvariant(d.id)).toBe(16_000);
  });

  it("insufficient balance at completion falls back to cash (driver pays commission), idempotently", async () => {
    const c = await login("customer");
    const d = await login("driver");
    await api("/wallet/topup", { token: c.token, body: { amount: 5_000 }, headers: { "Idempotency-Key": "a" } });
    await insertRide("qqguv_w2", c.id, d.id, 20_000, "WALLET");
    const args = { rideId: "qqguv_w2", customerId: c.id, driverId: d.id, fare: 20_000, paymentMethod: "WALLET" as const, commissionRate: 0.2 };
    const r1 = await settle(args);
    expect(r1).toEqual({ paidVia: "CASH", customerBalance: 5_000, driverBalance: -4_000 });
    // customer tops up afterwards: a retried settlement must still not charge the wallet
    await api("/wallet/topup", { token: c.token, body: { amount: 100_000 }, headers: { "Idempotency-Key": "b" } });
    const r2 = await settle(args);
    expect(r2).toEqual({ paidVia: "CASH", customerBalance: 105_000, driverBalance: -4_000 });
    await ledgerInvariant(c.id);
    await ledgerInvariant(d.id);
  });

  it("cash settlement: commission only", async () => {
    const c = await login("customer");
    const d = await login("driver");
    await insertRide("qqguv_c1", c.id, d.id, 15_500, "CASH");
    const r = await settle({ rideId: "qqguv_c1", customerId: c.id, driverId: d.id, fare: 15_500, paymentMethod: "CASH", commissionRate: 0.2 });
    expect(r).toEqual({ paidVia: "CASH", customerBalance: 0, driverBalance: -3_100 });
    const [ride] = await withSql(env, (sql) => sql`SELECT paid_via, paid_at FROM rides WHERE id = 'qqguv_c1'`);
    expect(ride!.paid_via).toBe("CASH");
    expect(ride!.paid_at).toBeGreaterThan(0);
  });
});
