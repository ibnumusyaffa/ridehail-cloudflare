import type { DriverStatus, ErrorCode, PaymentMethod, Place, RideStatus } from "@gojek/core";

export interface Vehicle {
  plate: string;
  model: string;
  color: string;
}

export interface DriverInfo {
  id: string;
  name: string;
  vehicle: Vehicle | null;
}

/** Ride as seen by clients (REST + WebSocket). */
export interface RideView {
  id: string;
  status: RideStatus;
  customerId: string;
  driverId: string | null;
  driver: DriverInfo | null;
  pickup: Place;
  dropoff: Place;
  distanceM: number;
  fare: number;
  fareFinal: number | null;
  paymentMethod: PaymentMethod;
  paidVia: PaymentMethod | null;
  paidAt: number | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  rating: number | null;
  requestedAt: number;
  acceptedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface OfferPayload {
  rideId: string;
  pickup: Place;
  dropoff: Place;
  fare: number;
  distanceM: number;
  paymentMethod: PaymentMethod;
  expiresAt: number;
}

export type ClientMsg =
  | { t: "online" }
  | { t: "offline" }
  | { t: "loc"; lat: number; lng: number; heading?: number; speed?: number }
  | { t: "offer.accept"; rideId: string }
  | { t: "offer.reject"; rideId: string }
  | { t: "ride.arrived"; rideId: string }
  | { t: "ride.start"; rideId: string }
  | { t: "ride.complete"; rideId: string }
  | { t: "resume"; rideId?: string }
  | { t: "ping" };

export type ServerMsg =
  | { t: "hello"; zone: string; role: string; driverStatus?: DriverStatus; rideId?: string | null }
  | { t: "driver.state"; status: DriverStatus; rideId: string | null }
  | ({ t: "offer" } & OfferPayload)
  | { t: "offer.cancelled"; rideId: string; reason: string }
  | { t: "ride.status"; rideId: string; status: RideStatus; driver: DriverInfo | null; at: number; ride: RideView }
  | { t: "ride.paid"; rideId: string; paidVia: PaymentMethod; fare: number; balance: number }
  | { t: "driver.loc"; rideId: string; lat: number; lng: number; heading: number | null }
  /** ON_TRIP and no location from the driver for a long while: ask the customer what happened */
  | { t: "ride.driver_lost"; rideId: string; lastSeenAt: number; autoCancelAt: number }
  | { t: "ride.driver_back"; rideId: string }
  | { t: "zone.moved"; zone: string; rideId?: string }
  | { t: "pong" }
  | { t: "error"; code: ErrorCode; message: string };

export type Result<T = object> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };

export const fail = (code: ErrorCode, message: string = code): { ok: false; code: ErrorCode; message: string } => ({
  ok: false,
  code,
  message,
});
