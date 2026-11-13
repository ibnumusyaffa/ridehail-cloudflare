import { describe, expect, it } from "vitest";
import { settle } from "../src";

const base = { rideId: "r1", customerId: "c", driverId: "d", fare: 15_500 } as const;

describe("settlement", () => {
  it("wallet: customer pays fare, driver earns fare minus commission", () => {
    const p = settle({ ...base, paymentMethod: "WALLET", commissionRate: 0.2 });
    expect(p.paidVia).toBe("WALLET");
    expect(p.commission).toBe(3_100);
    expect(p.entries).toEqual([
      { userId: "c", type: "RIDE_PAYMENT", amount: -15_500 },
      { userId: "d", type: "RIDE_EARNING", amount: 12_400 },
    ]);
  });
  it("cash: driver owes commission only", () => {
    const p = settle({ ...base, paymentMethod: "CASH", commissionRate: 0.2 });
    expect(p.paidVia).toBe("CASH");
    expect(p.entries).toEqual([{ userId: "d", type: "COMMISSION", amount: -3_100 }]);
  });
  it("wallet with insufficient balance falls back to cash", () => {
    const p = settle({ ...base, paymentMethod: "WALLET", commissionRate: 0.2 }, false);
    expect(p.paidVia).toBe("CASH");
    expect(p.entries).toEqual([{ userId: "d", type: "COMMISSION", amount: -3_100 }]);
  });
  it("zero commission cash = no entries; rounding to integer", () => {
    expect(settle({ ...base, paymentMethod: "CASH", commissionRate: 0 }).entries).toEqual([]);
    const p = settle({ ...base, fare: 10_001, paymentMethod: "WALLET", commissionRate: 0.15 });
    expect(p.entries.every((e) => Number.isInteger(e.amount))).toBe(true);
    expect(p.entries.reduce((s, e) => s + e.amount, 0)).toBe(-p.commission);
  });
});
