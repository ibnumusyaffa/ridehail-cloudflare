import type { PaymentMethod, WalletTxType } from "./types";

export interface SettlementInput {
  rideId: string;
  customerId: string;
  driverId: string;
  fare: number; // integer rupiah
  paymentMethod: PaymentMethod;
  commissionRate: number; // 0..1
}

export interface LedgerEntry {
  userId: string;
  type: WalletTxType;
  amount: number; // + in, - out
}

export interface SettlementPlan {
  paidVia: PaymentMethod;
  commission: number;
  entries: LedgerEntry[];
}

export function commissionOf(fare: number, rate: number): number {
  if (!Number.isInteger(fare) || fare < 0) throw new Error("fare must be a non-negative integer");
  if (rate < 0 || rate > 1) throw new Error("commission rate must be within [0, 1]");
  return Math.round(fare * rate);
}

/**
 * settle(ride, commissionRate) -> ledger entries. Pure.
 * `walletOk` = customer had enough balance at settlement time; if false a WALLET
 * ride falls back to CASH (customer pays the driver directly).
 */
export function settle(input: SettlementInput, walletOk = true): SettlementPlan {
  const commission = commissionOf(input.fare, input.commissionRate);
  const paidVia: PaymentMethod = input.paymentMethod === "WALLET" && walletOk ? "WALLET" : "CASH";
  const entries: LedgerEntry[] = [];
  if (paidVia === "WALLET") {
    entries.push({ userId: input.customerId, type: "RIDE_PAYMENT", amount: -input.fare });
    entries.push({ userId: input.driverId, type: "RIDE_EARNING", amount: input.fare - commission });
  } else if (commission > 0) {
    entries.push({ userId: input.driverId, type: "COMMISSION", amount: -commission });
  }
  return { paidVia, commission, entries };
}
