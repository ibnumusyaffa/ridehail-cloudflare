import type { DriverStatus, PaymentMethod, Place, Role, WalletTxType } from "@gojek/core";
import type { RideView, Vehicle } from "./protocol";

export interface User {
  id: string;
  role: Role;
  name: string;
  phone: string;
}

export interface WalletTx {
  id: string;
  type: WalletTxType;
  amount: number;
  balanceAfter: number;
  rideId: string | null;
  createdAt: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Typed REST client for the ride-hailing API. */
export class ApiClient {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
    /** called on any 401 (expired token, or the user was wiped by a dev reset) */
    private onUnauthorized?: () => void,
  ) {}

  private async req<T>(path: string, opts: { body?: unknown; idem?: string; method?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.idem) headers["Idempotency-Key"] = opts.idem;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (res.status === 401 && this.token) this.onUnauthorized?.();
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "HTTP_" + res.status, json?.error?.message ?? res.statusText);
    return json as T;
  }

  /** Dev only: wipe every user, ride, wallet and zone (API must run with DEV_RESET=1). */
  devReset() {
    return this.req<{ ok: true; zones: number }>("/dev/reset", { body: {} });
  }
  login(phone: string, role: Role, name?: string) {
    return this.req<{ token: string; user: User }>("/auth/login", { body: { phone, role, name } });
  }
  me() {
    return this.req<{ user: User; vehicle: Vehicle | null; wallet: { balance: number } }>("/me");
  }
  estimate(pickup: Place, dropoff: Place) {
    return this.req<{ distanceM: number; fare: number }>("/rides/estimate", { body: { pickup, dropoff } });
  }
  createRide(pickup: Place, dropoff: Place, paymentMethod: PaymentMethod) {
    return this.req<{ rideId: string; status: string; ride: RideView }>("/rides", {
      body: { pickup, dropoff, paymentMethod },
      idem: crypto.randomUUID(),
    });
  }
  activeRide() {
    return this.req<{ ride: RideView | null }>("/rides?active=1");
  }
  ride(id: string) {
    /** `commissionRate` only for the ride's driver */
    return this.req<{ ride: RideView; commissionRate?: number }>(`/rides/${id}`);
  }
  rides() {
    /** `today` and `commissionRate` only for drivers */
    return this.req<{ rides: RideView[]; today?: { count: number; gross: number; net: number }; commissionRate?: number }>("/rides?mine=1");
  }
  cancel(id: string, reason: string) {
    return this.req<{ ride: RideView }>(`/rides/${id}/cancel`, { body: { reason } });
  }

  /** Answer "the driver went silent mid-trip": "arrived" completes and pays, "cancel" ends it unpaid. */
  driverLost(id: string, action: "arrived" | "cancel") {
    return this.req<{ ride: RideView }>(`/rides/${id}/driver-lost`, { body: { action } });
  }
  rate(id: string, stars: number) {
    return this.req<{ ok: true }>(`/rides/${id}/rating`, { body: { stars } });
  }
  wallet() {
    return this.req<{ balance: number }>("/wallet");
  }
  topup(amount: number) {
    return this.req<{ balance: number }>("/wallet/topup", { body: { amount }, idem: crypto.randomUUID() });
  }
  transactions() {
    return this.req<{ transactions: WalletTx[] }>("/wallet/transactions");
  }
}

export type { DriverStatus };
