import { DomainError, type RideStatus, type Role } from "./types";

export type RideEvent =
  | { type: "OFFER" } // candidate reserved & offered
  | { type: "NO_CANDIDATE" }
  | { type: "ACCEPT" }
  | { type: "ARRIVE" }
  | { type: "START" }
  | { type: "COMPLETE" }
  | { type: "CANCEL"; by: Role | "system" };

export const ACTIVE_STATUSES: readonly RideStatus[] = ["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED", "ON_TRIP"];
export const TERMINAL_STATUSES: readonly RideStatus[] = ["COMPLETED", "CANCELLED", "NO_DRIVER"];

export function isTerminal(s: RideStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

const CANCELLABLE_BY: Record<Role | "system", readonly RideStatus[]> = {
  customer: ["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED"],
  driver: ["ACCEPTED", "ARRIVED"],
  // ON_TRIP too: a trip whose driver went silent for hours (phone dead) must not lock the customer forever
  system: ["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED", "ON_TRIP"],
};

function target(state: RideStatus, ev: RideEvent): RideStatus | null {
  switch (ev.type) {
    case "OFFER":
      return state === "REQUESTED" || state === "OFFERING" ? "OFFERING" : null;
    case "NO_CANDIDATE":
      return state === "REQUESTED" || state === "OFFERING" ? "NO_DRIVER" : null;
    case "ACCEPT":
      return state === "OFFERING" ? "ACCEPTED" : null;
    case "ARRIVE":
      return state === "ACCEPTED" ? "ARRIVED" : null;
    case "START":
      return state === "ARRIVED" ? "ON_TRIP" : null;
    case "COMPLETE":
      return state === "ON_TRIP" ? "COMPLETED" : null;
    case "CANCEL":
      return CANCELLABLE_BY[ev.by].includes(state) ? "CANCELLED" : null;
  }
}

/** Status each event lands on — used to detect duplicates (idempotency). */
const LANDS_ON: Partial<Record<RideEvent["type"], RideStatus>> = {
  ACCEPT: "ACCEPTED",
  ARRIVE: "ARRIVED",
  START: "ON_TRIP",
  COMPLETE: "COMPLETED",
  CANCEL: "CANCELLED",
  NO_CANDIDATE: "NO_DRIVER",
};

export interface Transition {
  status: RideStatus;
  /** false when the event is a duplicate and the state is unchanged */
  changed: boolean;
}

/**
 * apply(state, event) -> next state | INVALID_TRANSITION.
 * Replaying an event whose target equals the current state is a no-op (idempotent).
 */
export function applyRideEvent(state: RideStatus, ev: RideEvent): Transition {
  const next = target(state, ev);
  if (next) return { status: next, changed: next !== state || ev.type === "OFFER" };
  if (LANDS_ON[ev.type] === state) return { status: state, changed: false };
  throw new DomainError("INVALID_TRANSITION", `cannot ${ev.type} ride in ${state}`);
}
