import { commissionOf, type Role } from "@gojek/core";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api";
import type { RideView } from "../protocol";
import { type MapMarker, MapView } from "./MapView";
import { fmtKm, fmtRp, fmtTime, Icon, initials, Section, useRoute } from "./ui";

export const RIDE_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Searching for a driver",
  OFFERING: "Searching for a driver",
  ACCEPTED: "Driver on the way",
  ARRIVED: "Driver arrived",
  ON_TRIP: "On the trip",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_DRIVER: "No driver",
};

const CANCEL_REASON: Record<string, string> = {
  driver_lost: "Driver was disconnected too long",
  driver_lost_reported: "Customer reported the driver missing",
  drivers_cancelled: "Too many drivers cancelled",
};

const CANCELLED_BY: Record<string, string> = { customer: "Customer", driver: "Driver", system: "System" };

export const fmtDate = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

const fmtDur = (ms: number) => {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

const payLabel = (m: string | null) => (m === "WALLET" ? "Wallet" : m === "CASH" ? "Cash" : "—");

/**
 * Full-screen detail of a past (or current) ride, over the history list.
 * Shows what `RideView` already carries; `commissionRate` (driver only) splits the fare into commission and net.
 */
export function RideDetail({ ride: initial, role, api, commissionRate, onClose, onChange }: {
  ride: RideView;
  role: Role;
  api: ApiClient;
  commissionRate?: number;
  onClose: () => void;
  /** the ride was refreshed (e.g. after rating): lets the list update its row */
  onChange?: (r: RideView) => void;
}) {
  const [ride, setRide] = useState(initial);
  const [rate, setRate] = useState(commissionRate);
  const [err, setErr] = useState<string | null>(null);
  const [rating, setRating] = useState(false);

  // the list may be stale (the ride could have been rated / paid since): refresh once on open
  useEffect(() => {
    let live = true;
    api.ride(initial.id).then((r) => {
      if (!live) return;
      setRide(r.ride);
      if (r.commissionRate !== undefined) setRate(r.commissionRate);
      onChange?.(r.ride);
    }).catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  const route = useRoute(ride.pickup, ride.dropoff);
  const markers = useMemo<MapMarker[]>(() => [
    { id: "pickup", kind: "pickup", lat: ride.pickup.lat, lng: ride.pickup.lng, title: ride.pickup.label },
    { id: "dropoff", kind: "dropoff", lat: ride.dropoff.lat, lng: ride.dropoff.lng, title: ride.dropoff.label },
  ], [ride.pickup, ride.dropoff]);

  const fare = ride.fareFinal ?? ride.fare;
  const completed = ride.status === "COMPLETED";
  const commission = role === "driver" && completed && rate !== undefined ? commissionOf(fare, rate) : null;

  const steps: { label: string; at: number | null }[] = [
    { label: "Ordered", at: ride.requestedAt },
    { label: "Driver found", at: ride.acceptedAt },
    { label: "Driver arrived at pickup", at: ride.arrivedAt },
    { label: "Trip started", at: ride.startedAt },
    { label: "Completed", at: ride.completedAt },
    { label: "Cancelled", at: ride.cancelledAt },
    { label: "Paid", at: ride.paidAt },
  ];

  const rate1 = async (stars: number) => {
    setRating(true);
    setErr(null);
    try {
      await api.rate(ride.id, stars);
      const next = { ...ride, rating: stars };
      setRide(next);
      onChange?.(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRating(false);
    }
  };

  return (
    <div className="detail-sheet" data-testid="ride-detail" data-ride={ride.id} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="navbar">
        <button type="button" className="plain back" onClick={onClose} data-testid="ride-detail-back">
          <span className="flip"><Icon name="chevron" size={18} /></span>
          History
        </button>
        <div className="navbar-title">Trip details</div>
        <span />
      </div>
      <div className="detail-body">
        <div className="detail-map">
          <MapView
            center={ride.pickup}
            markers={markers}
            route={route?.points}
            fitKey={`${ride.id}:${route ? "r" : "p"}`}
            fitPoints={route?.points ?? [ride.pickup, ride.dropoff]}
            fitPadding={40}
            controls={false}
          />
        </div>

        <div className="detail-head">
          <span className={`pill st-${ride.status.toLowerCase()}`} data-testid="ride-detail-status">{RIDE_STATUS_LABEL[ride.status] ?? ride.status}</span>
          <div className="sub">{fmtDate(ride.requestedAt)} · {fmtTime(ride.requestedAt)} · #{ride.id.slice(-6).toUpperCase()}</div>
        </div>

        <Section head="Route">
          <div className="cell">
            <span className="ic green"><Icon name="pin" /></span>
            <div className="grow"><div className="sub">Pickup</div><div>{ride.pickup.label}</div></div>
          </div>
          <div className="cell">
            <span className="ic red"><Icon name="pin" /></span>
            <div className="grow"><div className="sub">Destination</div><div>{ride.dropoff.label}</div></div>
          </div>
          <div className="cell">
            <span className="grow">Distance</span>
            <span className="value tnum">{fmtKm(ride.distanceM)}</span>
          </div>
          {ride.startedAt && ride.completedAt && (
            <div className="cell">
              <span className="grow">Trip duration</span>
              <span className="value tnum">{fmtDur(ride.completedAt - ride.startedAt)}</span>
            </div>
          )}
        </Section>

        {role === "customer" && ride.driver && (
          <Section head="Driver">
            <div className="cell">
              <div className="avatar">{initials(ride.driver.name)}</div>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{ride.driver.name}</div>
                <div className="sub">{[ride.driver.vehicle?.model, ride.driver.vehicle?.color].filter(Boolean).join(" · ")}</div>
              </div>
              {ride.driver.vehicle?.plate && <span className="plate">{ride.driver.vehicle.plate}</span>}
            </div>
          </Section>
        )}

        <Section head={role === "driver" ? "Earnings" : "Payment"}>
          <div className="cell">
            <span className="grow">Fare</span>
            <span className="tnum" data-testid="ride-detail-fare">{fmtRp(fare)}</span>
          </div>
          <div className="cell">
            <span className="grow">Method</span>
            <span className="value">
              {payLabel(ride.paymentMethod)}
              {ride.paidVia && ride.paidVia !== ride.paymentMethod && ` → paid ${payLabel(ride.paidVia).toLowerCase()}`}
            </span>
          </div>
          {commission !== null && (
            <>
              <div className="cell">
                <span className="grow">Platform commission ({Math.round(rate! * 100)}%)</span>
                <span className="tnum">−{fmtRp(commission)}</span>
              </div>
              <div className="cell">
                <span className="grow" style={{ fontWeight: 600 }}>Net earnings</span>
                <b className="tnum pos" data-testid="ride-detail-net">{fmtRp(fare - commission)}</b>
              </div>
            </>
          )}
          {completed && !ride.paidAt && (
            <div className="cell"><span className="muted">Payment processing…</span></div>
          )}
        </Section>
        {role === "driver" && completed && ride.paidVia === "CASH" && commission !== null && (
          <div className="section-foot" style={{ marginTop: -14 }}>
            Cash {fmtRp(fare)} received directly from the customer; commission {fmtRp(commission)} taken from the wallet.
          </div>
        )}

        {ride.status === "CANCELLED" && (
          <Section head="Cancellation">
            <div className="cell">
              <span className="grow">By</span>
              <span className="value">{ride.cancelledBy ? CANCELLED_BY[ride.cancelledBy] ?? ride.cancelledBy : "—"}</span>
            </div>
            <div className="cell">
              <span className="grow">Reason</span>
              <span className="value" style={{ textAlign: "right" }}>
                {ride.cancelReason ? CANCEL_REASON[ride.cancelReason] ?? ride.cancelReason : "—"}
              </span>
            </div>
          </Section>
        )}

        <Section head="Status history">
          <ul className="list timeline">
            {steps.filter((s) => s.at !== null).map((s) => (
              <li key={s.label} className="cell">
                <span className="tl-dot" />
                <span className="grow">{s.label}</span>
                <span className="value tnum">{fmtTime(s.at!)}</span>
              </li>
            ))}
          </ul>
        </Section>

        {completed && (
          <Section head="Rating" foot={err ?? undefined}>
            <div className="cell" style={{ flexDirection: "column", gap: 4, paddingBlock: 14 }}>
              {role === "customer" && !ride.rating && <span className="muted">Rate this trip</span>}
              {role === "driver" && !ride.rating && <span className="muted">Customer hasn't rated yet</span>}
              {(ride.rating || role === "customer") && (
                <div className="stars" data-testid="ride-detail-rating" data-rating={ride.rating ?? 0}>
                  {[1, 2, 3, 4, 5].map((n) =>
                    role === "customer" && !ride.rating ? (
                      <button key={n} data-testid={`detail-star-${n}`} aria-label={`${n} stars`} disabled={rating} onClick={() => rate1(n)}>☆</button>
                    ) : (
                      <span key={n}>{n <= (ride.rating ?? 0) ? "★" : "☆"}</span>
                    ),
                  )}
                </div>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
