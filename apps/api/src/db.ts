import { ACTIVE_STATUSES, commissionOf, type PaymentMethod, type Role, type WalletTxType } from "@gojek/core";
import type { DriverInfo, RideView, Vehicle } from "./protocol";

export interface User {
  id: string;
  role: Role;
  name: string;
  phone: string;
  createdAt: number;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

// ---------------------------------------------------------------- users

const PLATES = ["B", "D", "F"];
const MODELS = ["Honda Beat", "Yamaha NMAX", "Honda Vario", "Suzuki Nex"];
const COLORS = ["Hitam", "Putih", "Merah", "Biru", "Abu-abu"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

function fakeVehicle(): Vehicle {
  const digits = 1000 + Math.floor(Math.random() * 9000);
  const suffix = String.fromCharCode(65 + Math.floor(Math.random() * 26), 65 + Math.floor(Math.random() * 26));
  return { plate: `${pick(PLATES)} ${digits} ${suffix}`, model: pick(MODELS), color: pick(COLORS) };
}

const rowToUser = (r: Record<string, unknown>): User => ({
  id: r.id as string,
  role: r.role as Role,
  name: r.name as string,
  phone: r.phone as string,
  createdAt: r.created_at as number,
});

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const r = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return r ? rowToUser(r) : null;
}

/** Find-or-create by phone. Returns null when the phone is registered with another role. */
export async function loginUser(db: D1Database, phone: string, role: Role, name?: string): Promise<User | null> {
  const existing = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
  if (existing) return existing.role === role ? rowToUser(existing) : null;

  const now = Date.now();
  const id = newId("u");
  const displayName = name?.trim() || `${role === "driver" ? "Driver" : "Customer"} ${phone.slice(-4)}`;
  const stmts = [
    db.prepare("INSERT INTO users (id, role, name, phone, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone) DO NOTHING")
      .bind(id, role, displayName, phone, now),
    db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance, updated_at) SELECT id, 0, ? FROM users WHERE phone = ?")
      .bind(now, phone),
  ];
  if (role === "driver") {
    const v = fakeVehicle();
    stmts.push(
      db.prepare("INSERT OR IGNORE INTO vehicles (driver_id, plate, model, color) SELECT id, ?, ?, ? FROM users WHERE phone = ?")
        .bind(v.plate, v.model, v.color, phone),
    );
  }
  await db.batch(stmts);
  // re-read: a concurrent login may have won the insert
  const r = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
  return r && r.role === role ? rowToUser(r) : null;
}

export async function getVehicle(db: D1Database, driverId: string): Promise<Vehicle | null> {
  const r = await db.prepare("SELECT plate, model, color FROM vehicles WHERE driver_id = ?").bind(driverId).first<Vehicle>();
  return r ?? null;
}

// ---------------------------------------------------------------- rides

const ACTIVE_SQL = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");

function rowToRide(r: Record<string, unknown>): RideView {
  return {
    id: r.id as string,
    status: r.status as RideView["status"],
    customerId: r.customer_id as string,
    driverId: (r.driver_id as string | null) ?? null,
    driver: r.driver_id
      ? {
          id: r.driver_id as string,
          name: (r.driver_name as string) ?? "",
          vehicle: r.plate ? { plate: r.plate as string, model: r.model as string, color: r.color as string } : null,
        }
      : null,
    pickup: { lat: r.pickup_lat as number, lng: r.pickup_lng as number, label: (r.pickup_label as string) ?? undefined },
    dropoff: { lat: r.drop_lat as number, lng: r.drop_lng as number, label: (r.drop_label as string) ?? undefined },
    distanceM: r.distance_m as number,
    fare: r.fare_estimate as number,
    fareFinal: (r.fare_final as number | null) ?? null,
    paymentMethod: r.payment_method as PaymentMethod,
    paidVia: (r.paid_via as PaymentMethod | null) ?? null,
    paidAt: (r.paid_at as number | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    cancelledBy: (r.cancelled_by as string | null) ?? null,
    rating: (r.rating as number | null) ?? null,
    requestedAt: r.requested_at as number,
    acceptedAt: (r.accepted_at as number | null) ?? null,
    arrivedAt: (r.arrived_at as number | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    completedAt: (r.completed_at as number | null) ?? null,
    cancelledAt: (r.cancelled_at as number | null) ?? null,
  };
}

const RIDE_SELECT = `
  SELECT r.*, u.name AS driver_name, v.plate, v.model, v.color
  FROM rides r
  LEFT JOIN users u ON u.id = r.driver_id
  LEFT JOIN vehicles v ON v.driver_id = r.driver_id`;

export async function getRide(db: D1Database, id: string): Promise<RideView | null> {
  const r = await db.prepare(`${RIDE_SELECT} WHERE r.id = ?`).bind(id).first();
  return r ? rowToRide(r) : null;
}

export async function getRideByIdempotencyKey(db: D1Database, customerId: string, key: string): Promise<RideView | null> {
  const r = await db.prepare(`${RIDE_SELECT} WHERE r.customer_id = ? AND r.idempotency_key = ?`).bind(customerId, key).first();
  return r ? rowToRide(r) : null;
}

export async function getActiveRide(db: D1Database, userId: string, role: Role): Promise<RideView | null> {
  const col = role === "driver" ? "driver_id" : "customer_id";
  const r = await db
    .prepare(`${RIDE_SELECT} WHERE r.${col} = ? AND r.status IN (${ACTIVE_SQL}) ORDER BY r.requested_at DESC LIMIT 1`)
    .bind(userId)
    .first();
  return r ? rowToRide(r) : null;
}

export async function listRides(db: D1Database, userId: string, role: Role, limit = 50): Promise<RideView[]> {
  const col = role === "driver" ? "driver_id" : "customer_id";
  const { results } = await db
    .prepare(`${RIDE_SELECT} WHERE r.${col} = ? ORDER BY r.requested_at DESC LIMIT ?`)
    .bind(userId, limit)
    .all();
  return results.map(rowToRide);
}

/** Write-through of the hot ride state. Settlement fields and rating are owned by other writers. */
export function upsertRideStmt(db: D1Database, r: RideView, idempotencyKey: string | null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rides (id, customer_id, driver_id, pickup_lat, pickup_lng, pickup_label, drop_lat, drop_lng, drop_label,
         status, fare_estimate, fare_final, distance_m, payment_method, cancel_reason, cancelled_by, idempotency_key,
         requested_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         driver_id = excluded.driver_id, status = excluded.status, fare_final = excluded.fare_final,
         cancel_reason = excluded.cancel_reason, cancelled_by = excluded.cancelled_by,
         accepted_at = excluded.accepted_at, arrived_at = excluded.arrived_at, started_at = excluded.started_at,
         completed_at = excluded.completed_at, cancelled_at = excluded.cancelled_at`,
    )
    .bind(
      r.id, r.customerId, r.driverId, r.pickup.lat, r.pickup.lng, r.pickup.label ?? null,
      r.dropoff.lat, r.dropoff.lng, r.dropoff.label ?? null, r.status, r.fare, r.fareFinal, r.distanceM,
      r.paymentMethod, r.cancelReason, r.cancelledBy, idempotencyKey, r.requestedAt, r.acceptedAt, r.arrivedAt,
      r.startedAt, r.completedAt, r.cancelledAt,
    );
}

export async function rateRide(db: D1Database, rideId: string, customerId: string, stars: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE rides SET rating = ? WHERE id = ? AND customer_id = ? AND status = 'COMPLETED' AND rating IS NULL")
    .bind(stars, rideId, customerId)
    .run();
  return res.meta.changes > 0;
}

// ---------------------------------------------------------------- wallet

export interface WalletTx {
  id: string;
  type: WalletTxType;
  amount: number;
  balanceAfter: number;
  rideId: string | null;
  createdAt: number;
}

export async function getBalance(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare("SELECT balance FROM wallets WHERE user_id = ?").bind(userId).first<{ balance: number }>();
  return r?.balance ?? 0;
}

export async function listTransactions(db: D1Database, userId: string, limit = 100): Promise<WalletTx[]> {
  const { results } = await db
    .prepare("SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(userId, limit)
    .all();
  return results.map((r) => ({
    id: r.id as string,
    type: r.type as WalletTxType,
    amount: r.amount as number,
    balanceAfter: r.balance_after as number,
    rideId: (r.ride_id as string | null) ?? null,
    createdAt: r.created_at as number,
  }));
}

/**
 * Credit `amount` once per (user, idempotencyKey). Atomic: ledger row + balance in one batch,
 * the balance update is guarded by the existence of *this* call's ledger row.
 */
export async function topup(db: D1Database, userId: string, amount: number, idemKey: string): Promise<number> {
  const txId = newId("tx");
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO wallet_transactions (id, user_id, type, amount, balance_after, idempotency_key, created_at)
       SELECT ?, user_id, 'TOPUP', ?, balance + ?, ?, ? FROM wallets WHERE user_id = ?`,
    ).bind(txId, amount, amount, idemKey, now, userId),
    db.prepare(
      "UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND EXISTS (SELECT 1 FROM wallet_transactions WHERE id = ?)",
    ).bind(amount, now, userId, txId),
  ]);
  return getBalance(db, userId);
}

export interface SettleArgs {
  rideId: string;
  customerId: string;
  driverId: string;
  fare: number;
  paymentMethod: PaymentMethod;
  commissionRate: number;
}

export interface SettleResult {
  paidVia: PaymentMethod;
  customerBalance: number;
  driverBalance: number;
}

/**
 * Settle a COMPLETED ride in ONE D1 batch (atomic), idempotent:
 *  - every insert is guarded by `rides.paid_at IS NULL` (set by the last statement) and
 *    UNIQUE(ride_id, user_id, type), so re-running never charges twice;
 *  - every balance update is guarded by the existence of the ledger row *this* run inserted,
 *    keeping `balance == SUM(amount)`;
 *  - WALLET deducts only `WHERE balance >= fare`; otherwise falls back to CASH (driver pays commission).
 * Mirrors the pure `settle()` in @gojek/core, but evaluated inside the transaction.
 */
export async function settleRide(db: D1Database, a: SettleArgs): Promise<SettleResult> {
  const now = Date.now();
  const commission = commissionOf(a.fare, a.commissionRate);
  const earning = a.fare - commission;
  const payId = newId("tx");
  const earnId = newId("tx");
  const commId = newId("tx");
  const unpaid = "NOT EXISTS (SELECT 1 FROM rides WHERE id = ?1 AND paid_at IS NOT NULL)";
  const paidByWallet = "EXISTS (SELECT 1 FROM wallet_transactions WHERE ride_id = ?1 AND type = 'RIDE_PAYMENT')";
  const txExists = "EXISTS (SELECT 1 FROM wallet_transactions WHERE id = ?)";

  const stmts: D1PreparedStatement[] = [];
  if (a.paymentMethod === "WALLET") {
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO wallet_transactions (id, user_id, type, amount, balance_after, ride_id, created_at)
         SELECT ?2, user_id, 'RIDE_PAYMENT', -?3, balance - ?3, ?1, ?4 FROM wallets
         WHERE user_id = ?5 AND balance >= ?3 AND ${unpaid}`,
      ).bind(a.rideId, payId, a.fare, now, a.customerId),
      db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND ${txExists}`)
        .bind(a.fare, now, a.customerId, payId),
      db.prepare(
        `INSERT OR IGNORE INTO wallet_transactions (id, user_id, type, amount, balance_after, ride_id, created_at)
         SELECT ?2, user_id, 'RIDE_EARNING', ?3, balance + ?3, ?1, ?4 FROM wallets
         WHERE user_id = ?5 AND EXISTS (SELECT 1 FROM wallet_transactions WHERE id = ?6)`,
      ).bind(a.rideId, earnId, earning, now, a.driverId, payId),
      db.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND ${txExists}`)
        .bind(earning, now, a.driverId, earnId),
    );
  }
  if (commission > 0) {
    // CASH ride, or WALLET ride that fell back to cash: driver owes the platform its commission.
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO wallet_transactions (id, user_id, type, amount, balance_after, ride_id, created_at)
         SELECT ?2, user_id, 'COMMISSION', -?3, balance - ?3, ?1, ?4 FROM wallets
         WHERE user_id = ?5 AND ${unpaid} AND NOT ${paidByWallet}`,
      ).bind(a.rideId, commId, commission, now, a.driverId),
      db.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND ${txExists}`)
        .bind(commission, now, a.driverId, commId),
    );
  }
  stmts.push(
    db.prepare(
      `UPDATE rides SET
         paid_via = CASE WHEN ${paidByWallet} THEN 'WALLET' ELSE 'CASH' END,
         paid_at = ?2, fare_final = COALESCE(fare_final, ?3)
       WHERE id = ?1 AND paid_at IS NULL`,
    ).bind(a.rideId, now, a.fare),
    db.prepare("SELECT paid_via FROM rides WHERE id = ?").bind(a.rideId),
    db.prepare("SELECT user_id, balance FROM wallets WHERE user_id IN (?, ?)").bind(a.customerId, a.driverId),
  );

  const results = await db.batch(stmts);
  const paidRow = results[results.length - 2]!.results[0] as { paid_via: PaymentMethod } | undefined;
  const balances = results[results.length - 1]!.results as { user_id: string; balance: number }[];
  const bal = (id: string) => balances.find((b) => b.user_id === id)?.balance ?? 0;
  return { paidVia: paidRow?.paid_via ?? "CASH", customerBalance: bal(a.customerId), driverBalance: bal(a.driverId) };
}

export type { DriverInfo };
