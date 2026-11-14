import { ACTIVE_STATUSES, commissionOf, type ErrorCode, type PaymentMethod, type Role, type WalletTxType } from "@gojek/core";
import { begin, isUniqueViolation, type Sql, type Tx } from "./pg";
import type { DriverInfo, RideView, Vehicle } from "./protocol";

export interface User {
  id: string;
  role: Role;
  name: string;
  phone: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const ACTIVE = [...ACTIVE_STATUSES] as string[];
const RELEASE_ON = ["CANCELLED", "NO_DRIVER"];

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

const rowToUser = (r: Row): User => ({
  id: r.id as string,
  role: r.role as Role,
  name: r.name as string,
  phone: r.phone as string,
  createdAt: r.created_at as number,
});

export async function getUser(sql: Sql, id: string): Promise<User | null> {
  const [r] = await sql`SELECT * FROM users WHERE id = ${id}`;
  return r ? rowToUser(r) : null;
}

/** Find-or-create by phone. Returns null when the phone is registered with another role. */
export async function loginUser(sql: Sql, phone: string, role: Role, name?: string): Promise<User | null> {
  const [existing] = await sql`SELECT * FROM users WHERE phone = ${phone}`;
  if (existing) return existing.role === role ? rowToUser(existing) : null;

  const now = Date.now();
  const displayName = name?.trim() || `${role === "driver" ? "Driver" : "Customer"} ${phone.slice(-4)}`;
  const user = await begin(sql, async (tx) => {
    const [u] = await tx`
      INSERT INTO users (id, role, name, phone, created_at) VALUES (${newId("u")}, ${role}, ${displayName}, ${phone}, ${now})
      ON CONFLICT (phone) DO NOTHING RETURNING *`;
    if (!u) return null; // a concurrent login won the insert
    await tx`INSERT INTO wallets (user_id, balance, updated_at) VALUES (${u.id as string}, 0, ${now})`;
    if (role === "driver") {
      const v = fakeVehicle();
      await tx`INSERT INTO vehicles (driver_id, plate, model, color) VALUES (${u.id as string}, ${v.plate}, ${v.model}, ${v.color})`;
    }
    return u;
  });
  const r = user ?? (await sql`SELECT * FROM users WHERE phone = ${phone}`)[0];
  return r && r.role === role ? rowToUser(r) : null;
}

export async function getVehicle(sql: Sql, driverId: string): Promise<Vehicle | null> {
  const [r] = await sql`SELECT plate, model, color FROM vehicles WHERE driver_id = ${driverId}`;
  return r ? { plate: r.plate as string, model: r.model as string, color: r.color as string } : null;
}

// ---------------------------------------------------------------- rides

function rowToRide(r: Row): RideView {
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

const rideSelect = (sql: Sql) => sql`
  SELECT r.*, u.name AS driver_name, v.plate, v.model, v.color
  FROM rides r
  LEFT JOIN users u ON u.id = r.driver_id
  LEFT JOIN vehicles v ON v.driver_id = r.driver_id`;

export async function getRide(sql: Sql, id: string): Promise<RideView | null> {
  const [r] = await sql`${rideSelect(sql)} WHERE r.id = ${id}`;
  return r ? rowToRide(r) : null;
}

export async function getRideByIdempotencyKey(sql: Sql, customerId: string, key: string): Promise<RideView | null> {
  const [r] = await sql`${rideSelect(sql)} WHERE r.customer_id = ${customerId} AND r.idempotency_key = ${key}`;
  return r ? rowToRide(r) : null;
}

export async function getActiveRide(sql: Sql, userId: string, role: Role): Promise<RideView | null> {
  const col = role === "driver" ? sql`r.driver_id` : sql`r.customer_id`;
  const [r] = await sql`
    ${rideSelect(sql)} WHERE ${col} = ${userId} AND r.status = ANY(${ACTIVE}::text[])
    ORDER BY r.requested_at DESC LIMIT 1`;
  return r ? rowToRide(r) : null;
}

export async function listRides(sql: Sql, userId: string, role: Role, limit = 50): Promise<RideView[]> {
  const col = role === "driver" ? sql`r.driver_id` : sql`r.customer_id`;
  const rows = await sql`${rideSelect(sql)} WHERE ${col} = ${userId} ORDER BY r.requested_at DESC LIMIT ${limit}`;
  return rows.map(rowToRide);
}

/** Completed rides of a driver since `since` (epoch ms): count, gross fare, net of commission. */
export async function driverEarnings(sql: Sql, driverId: string, since: number, commissionRate: number) {
  const [r] = await sql`
    SELECT COUNT(*)::int8 AS count,
           COALESCE(SUM(COALESCE(fare_final, fare_estimate)), 0)::int8 AS gross,
           COALESCE(SUM(COALESCE(fare_final, fare_estimate)
             - ROUND(COALESCE(fare_final, fare_estimate) * ${commissionRate}::numeric)), 0)::int8 AS net
    FROM rides WHERE driver_id = ${driverId} AND status = 'COMPLETED' AND completed_at >= ${since}`;
  return { count: r!.count as number, gross: r!.gross as number, net: r!.net as number };
}

async function insertRideTx(tx: Tx, r: RideView, idempotencyKey: string | null) {
  await tx`
    INSERT INTO rides (id, customer_id, driver_id, pickup_lat, pickup_lng, pickup_label, drop_lat, drop_lng, drop_label,
      status, fare_estimate, fare_final, distance_m, payment_method, cancel_reason, cancelled_by, idempotency_key,
      requested_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at)
    VALUES (${r.id}, ${r.customerId}, ${r.driverId}, ${r.pickup.lat}, ${r.pickup.lng}, ${r.pickup.label ?? null},
      ${r.dropoff.lat}, ${r.dropoff.lng}, ${r.dropoff.label ?? null}, ${r.status}, ${r.fare}, ${r.fareFinal}, ${r.distanceM},
      ${r.paymentMethod}, ${r.cancelReason}, ${r.cancelledBy}, ${idempotencyKey}, ${r.requestedAt}, ${r.acceptedAt},
      ${r.arrivedAt}, ${r.startedAt}, ${r.completedAt}, ${r.cancelledAt})`;
}

export type CreateRideResult =
  | { ok: true; ride: RideView; existing: boolean }
  | { ok: false; code: ErrorCode; message: string };

/**
 * Insert a new ride synchronously (before dispatch). The database enforces, across every zone:
 *  - one active ride per customer (`one_active_ride`), and
 *  - idempotency per (customer, Idempotency-Key) (`rides_idem`) → the existing ride is returned.
 * WALLET rides also place a hold on the customer's available balance in the same transaction.
 */
export async function createRide(sql: Sql, r: RideView, idempotencyKey: string | null): Promise<CreateRideResult> {
  try {
    return await begin(sql, async (tx) => {
      await insertRideTx(tx, r, idempotencyKey);
      if (r.paymentMethod === "WALLET") {
        const [w] = await tx`SELECT balance FROM wallets WHERE user_id = ${r.customerId} FOR UPDATE`;
        const [h] = await tx`SELECT COALESCE(SUM(amount), 0)::int8 AS held FROM wallet_holds WHERE user_id = ${r.customerId} AND status = 'ACTIVE'`;
        const available = ((w?.balance as number) ?? 0) - (h!.held as number);
        if (available < r.fare) throw new InsufficientBalance(`balance ${available} < fare ${r.fare}`);
        await tx`
          INSERT INTO wallet_holds (ride_id, user_id, amount, status, created_at, updated_at)
          VALUES (${r.id}, ${r.customerId}, ${r.fare}, 'ACTIVE', ${r.requestedAt}, ${r.requestedAt})`;
      }
      return { ok: true as const, ride: r, existing: false };
    });
  } catch (e) {
    if (e instanceof InsufficientBalance) return { ok: false, code: "INSUFFICIENT_BALANCE", message: e.message };
    if (!isUniqueViolation(e)) throw e;
    if (idempotencyKey) {
      const prev = await getRideByIdempotencyKey(sql, r.customerId, idempotencyKey);
      if (prev) return { ok: true, ride: prev, existing: true };
    }
    const active = await getActiveRide(sql, r.customerId, "customer");
    return { ok: false, code: "ACTIVE_RIDE_EXISTS", message: `active ride ${active?.id ?? "exists"}` };
  }
}

class InsufficientBalance extends Error {}

export type TransitionResult =
  | { ok: true; settled: SettleResult | null }
  /** the row is not at the expected version: its current state */
  | { ok: false; reason: "STALE"; current: RideView | null; version: number }
  /** the driver already has another active ride (`one_active_ride_driver`) */
  | { ok: false; reason: "DRIVER_BUSY" };

/**
 * Apply one ride transition in Postgres — the source of truth for ride status — in one transaction:
 *  - compare-and-set on `version` (the row as the zone actor last knew it), bumped by one: two racing
 *    transitions can never both win, and a late copy of a write can never land after a fence;
 *  - a cancelled / unmatched WALLET ride releases its hold;
 *  - `settle` (COMPLETE) settles the fare in the same transaction.
 */
export async function transitionRide(
  sql: Sql,
  r: RideView,
  version: number,
  settle: SettleArgs | null,
): Promise<TransitionResult> {
  try {
    return await begin(sql, async (tx) => {
      const changed = await tx`
        UPDATE rides SET status = ${r.status}, driver_id = ${r.driverId}, fare_final = ${r.fareFinal},
          cancel_reason = ${r.cancelReason}, cancelled_by = ${r.cancelledBy},
          accepted_at = ${r.acceptedAt}, arrived_at = ${r.arrivedAt}, started_at = ${r.startedAt},
          completed_at = ${r.completedAt}, cancelled_at = ${r.cancelledAt}, version = version + 1
        WHERE id = ${r.id} AND version = ${version}
        RETURNING id`;
      if (!changed.length) return { ok: false as const, reason: "STALE" as const, ...(await currentTx(tx, r.id)) };
      if (RELEASE_ON.includes(r.status))
        await tx`UPDATE wallet_holds SET status = 'RELEASED', updated_at = ${Date.now()} WHERE ride_id = ${r.id} AND status = 'ACTIVE'`;
      return { ok: true as const, settled: settle ? await settleRideTx(tx, settle) : null };
    });
  } catch (e) {
    if (isUniqueViolation(e, "one_active_ride_driver")) return { ok: false, reason: "DRIVER_BUSY" };
    throw e;
  }
}

export type FenceResult = { fenced: true } | { fenced: false; current: RideView | null; version: number };

/**
 * Settle the fate of a transition whose reply was lost (it expected `version`): bump the version from
 * that value. Fenced → the transition had not committed and now never will. Not fenced → the row moved
 * on (normally: the transition committed); its current state is returned. Waits for a transaction
 * still holding the row, so the answer is final.
 */
export async function fenceRide(sql: Sql, rideId: string, version: number): Promise<FenceResult> {
  return begin(sql, async (tx) => {
    const fenced = await tx`UPDATE rides SET version = version + 1 WHERE id = ${rideId} AND version = ${version} RETURNING id`;
    if (fenced.length) return { fenced: true as const };
    return { fenced: false as const, ...(await currentTx(tx, rideId)) };
  });
}

async function currentTx(tx: Tx, rideId: string): Promise<{ current: RideView | null; version: number }> {
  const [cur] = await tx`${rideSelect(tx as unknown as Sql)} WHERE r.id = ${rideId}`;
  return { current: cur ? rowToRide(cur) : null, version: (cur?.version as number | undefined) ?? 0 };
}

export async function rateRide(sql: Sql, rideId: string, customerId: string, stars: number): Promise<boolean> {
  const res = await sql`
    UPDATE rides SET rating = ${stars}
    WHERE id = ${rideId} AND customer_id = ${customerId} AND status = 'COMPLETED' AND rating IS NULL`;
  return res.count > 0;
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

export async function getBalance(sql: Sql, userId: string): Promise<number> {
  const [r] = await sql`SELECT balance FROM wallets WHERE user_id = ${userId}`;
  return (r?.balance as number) ?? 0;
}

/** Balance plus the part of it held for an in-flight WALLET ride. */
export async function getWallet(sql: Sql, userId: string): Promise<{ balance: number; held: number }> {
  const [r] = await sql`
    SELECT COALESCE(w.balance, 0)::int8 AS balance,
           (SELECT COALESCE(SUM(amount), 0) FROM wallet_holds WHERE user_id = ${userId} AND status = 'ACTIVE')::int8 AS held
    FROM (SELECT ${userId}::text AS id) u LEFT JOIN wallets w ON w.user_id = u.id`;
  return { balance: r!.balance as number, held: r!.held as number };
}

export async function listTransactions(sql: Sql, userId: string, limit = 100): Promise<WalletTx[]> {
  const rows = await sql`
    SELECT * FROM wallet_transactions WHERE user_id = ${userId} ORDER BY created_at DESC, seq DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    type: r.type as WalletTxType,
    amount: r.amount as number,
    balanceAfter: r.balance_after as number,
    rideId: (r.ride_id as string | null) ?? null,
    createdAt: r.created_at as number,
  }));
}

/** Credit `amount` once per (user, idempotencyKey): ledger row + balance in one transaction. */
export async function topup(sql: Sql, userId: string, amount: number, idemKey: string): Promise<number> {
  const now = Date.now();
  return begin(sql, async (tx) => {
    const [w] = await tx`SELECT balance FROM wallets WHERE user_id = ${userId} FOR UPDATE`;
    if (!w) throw new Error(`wallet missing for ${userId}`);
    const balance = w.balance as number;
    const inserted = await tx`
      INSERT INTO wallet_transactions (id, user_id, type, amount, balance_after, idempotency_key, created_at)
      VALUES (${newId("tx")}, ${userId}, 'TOPUP', ${amount}, ${balance + amount}, ${idemKey}, ${now})
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`;
    if (!inserted.length) return balance;
    await tx`UPDATE wallets SET balance = balance + ${amount}, updated_at = ${now} WHERE user_id = ${userId}`;
    return balance + amount;
  });
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
 * Settle a COMPLETED ride in one transaction, idempotently (the ride row is locked and `paid_at`
 * marks it settled; ledger rows are also UNIQUE(ride_id, user_id, type)):
 *  - WALLET: customer pays the fare, driver earns fare − commission; the hold is captured.
 *    If the balance is somehow short (no hold), it falls back to CASH.
 *  - CASH: the driver owes the platform its commission.
 * Mirrors the pure `settle()` in @gojek/core.
 */
export function settleRide(sql: Sql, a: SettleArgs): Promise<SettleResult> {
  return begin(sql, (tx) => settleRideTx(tx, a));
}

async function settleRideTx(tx: Tx, a: SettleArgs): Promise<SettleResult> {
  const now = Date.now();
  const commission = commissionOf(a.fare, a.commissionRate);
  const earning = a.fare - commission;
  const [ride] = await tx`SELECT paid_at, paid_via FROM rides WHERE id = ${a.rideId} FOR UPDATE`;
  if (!ride) throw new Error(`ride ${a.rideId} not found`);
  // lock both wallets in a fixed order (no deadlock between concurrent settlements)
  const ws = await tx`
    SELECT user_id, balance FROM wallets WHERE user_id IN (${a.customerId}, ${a.driverId}) ORDER BY user_id FOR UPDATE`;
  const bal = new Map(ws.map((w) => [w.user_id as string, w.balance as number]));
  const balance = (id: string) => bal.get(id) ?? 0;

  let paidVia = ride.paid_via as PaymentMethod | null;
  if (ride.paid_at === null) {
    const entry = async (userId: string, type: WalletTxType, amount: number) => {
      const after = balance(userId) + amount;
      await tx`
        INSERT INTO wallet_transactions (id, user_id, type, amount, balance_after, ride_id, created_at)
        VALUES (${newId("tx")}, ${userId}, ${type}, ${amount}, ${after}, ${a.rideId}, ${now})`;
      await tx`UPDATE wallets SET balance = ${after}, updated_at = ${now} WHERE user_id = ${userId}`;
      bal.set(userId, after);
    };
    paidVia = "CASH";
    if (a.paymentMethod === "WALLET" && balance(a.customerId) >= a.fare) {
      await entry(a.customerId, "RIDE_PAYMENT", -a.fare);
      await entry(a.driverId, "RIDE_EARNING", earning);
      paidVia = "WALLET";
    } else if (commission > 0) {
      await entry(a.driverId, "COMMISSION", -commission);
    }
    await tx`
      UPDATE wallet_holds SET status = ${paidVia === "WALLET" ? "CAPTURED" : "RELEASED"}, updated_at = ${now}
      WHERE ride_id = ${a.rideId} AND status = 'ACTIVE'`;
    await tx`
      UPDATE rides SET paid_via = ${paidVia}, paid_at = ${now}, fare_final = COALESCE(fare_final, ${a.fare})
      WHERE id = ${a.rideId}`;
  }
  return { paidVia: paidVia ?? "CASH", customerBalance: balance(a.customerId), driverBalance: balance(a.driverId) };
}

// ---------------------------------------------------------------- zones / dev

export async function registerZone(sql: Sql, zone: string): Promise<void> {
  await sql`INSERT INTO zones (zone, first_seen) VALUES (${zone}, ${Date.now()}) ON CONFLICT (zone) DO NOTHING`;
}

export async function listZones(sql: Sql): Promise<string[]> {
  return (await sql`SELECT zone FROM zones`).map((r) => r.zone as string);
}

/** Dev only: wipe every table. */
export async function wipeAll(sql: Sql): Promise<void> {
  await sql`TRUNCATE wallet_holds, wallet_transactions, wallets, rides, vehicles, users, zones`;
}

export type { DriverInfo };
