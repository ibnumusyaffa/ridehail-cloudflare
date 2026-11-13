import { describe, expect, it } from "vitest";
import { applyRideEvent, type RideEvent, type RideStatus } from "../src";

const ALL: RideStatus[] = ["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED", "ON_TRIP", "COMPLETED", "CANCELLED", "NO_DRIVER"];

describe("ride state machine", () => {
  it("happy path", () => {
    let s: RideStatus = "REQUESTED";
    for (const [ev, want] of [
      [{ type: "OFFER" }, "OFFERING"],
      [{ type: "OFFER" }, "OFFERING"],
      [{ type: "ACCEPT" }, "ACCEPTED"],
      [{ type: "ARRIVE" }, "ARRIVED"],
      [{ type: "START" }, "ON_TRIP"],
      [{ type: "COMPLETE" }, "COMPLETED"],
    ] as [RideEvent, RideStatus][]) {
      s = applyRideEvent(s, ev).status;
      expect(s).toBe(want);
    }
  });

  it("no driver from REQUESTED or OFFERING", () => {
    expect(applyRideEvent("REQUESTED", { type: "NO_CANDIDATE" }).status).toBe("NO_DRIVER");
    expect(applyRideEvent("OFFERING", { type: "NO_CANDIDATE" }).status).toBe("NO_DRIVER");
  });

  it("cancel rules", () => {
    for (const s of ["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED"] as RideStatus[])
      expect(applyRideEvent(s, { type: "CANCEL", by: "customer" }).status).toBe("CANCELLED");
    for (const s of ["ACCEPTED", "ARRIVED"] as RideStatus[])
      expect(applyRideEvent(s, { type: "CANCEL", by: "driver" }).status).toBe("CANCELLED");
    expect(() => applyRideEvent("OFFERING", { type: "CANCEL", by: "driver" })).toThrow(/INVALID_TRANSITION|cannot/);
    expect(() => applyRideEvent("ON_TRIP", { type: "CANCEL", by: "customer" })).toThrow();
    expect(() => applyRideEvent("COMPLETED", { type: "CANCEL", by: "customer" })).toThrow();
  });

  it("duplicate events are idempotent no-ops", () => {
    expect(applyRideEvent("ACCEPTED", { type: "ACCEPT" })).toEqual({ status: "ACCEPTED", changed: false });
    expect(applyRideEvent("COMPLETED", { type: "COMPLETE" })).toEqual({ status: "COMPLETED", changed: false });
    expect(applyRideEvent("CANCELLED", { type: "CANCEL", by: "customer" })).toEqual({ status: "CANCELLED", changed: false });
  });

  it("rejects every other transition", () => {
    const valid: Record<string, RideStatus[]> = {
      OFFER: ["REQUESTED", "OFFERING"],
      NO_CANDIDATE: ["REQUESTED", "OFFERING", "NO_DRIVER"],
      ACCEPT: ["OFFERING", "ACCEPTED"],
      ARRIVE: ["ACCEPTED", "ARRIVED"],
      START: ["ARRIVED", "ON_TRIP"],
      COMPLETE: ["ON_TRIP", "COMPLETED"],
    };
    for (const [type, ok] of Object.entries(valid)) {
      for (const s of ALL) {
        const run = () => applyRideEvent(s, { type } as RideEvent);
        if (ok.includes(s)) expect(run).not.toThrow();
        else expect(run, `${type} from ${s}`).toThrow();
      }
    }
  });
});
