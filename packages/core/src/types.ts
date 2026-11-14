export type Role = "customer" | "driver";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place extends LatLng {
  label?: string;
}

export type RideStatus =
  | "REQUESTED"
  | "OFFERING"
  | "ACCEPTED"
  | "ARRIVED"
  | "ON_TRIP"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_DRIVER";

export type DriverStatus = "OFFLINE" | "AVAILABLE" | "RESERVED" | "ON_RIDE";

export type PaymentMethod = "CASH" | "WALLET";

export type WalletTxType = "TOPUP" | "RIDE_PAYMENT" | "RIDE_EARNING" | "COMMISSION" | "ADJUSTMENT";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "RIDE_NOT_FOUND"
  | "DRIVER_BUSY"
  | "OFFER_EXPIRED"
  | "INSUFFICIENT_BALANCE"
  | "DRIVER_BALANCE_TOO_LOW"
  | "BAD_REQUEST"
  | "ACTIVE_RIDE_EXISTS"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
