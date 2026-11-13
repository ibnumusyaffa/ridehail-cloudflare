import { ApiClient, type User } from "@gojek/client/api";
import { PRESET_TRIPS } from "@gojek/client/presets";
import type { DriverInfo, RideView, ServerMsg } from "@gojek/client/protocol";
import {
  ConnDot, fmtKm, fmtRp, fmtTime, LoginForm, MapView, type MapMarker, ResetButton, Toast, useRoute, useStored, WalletPanel, wipeLocalAndReload,
} from "@gojek/client/react";
import { pathLength, trimFrom } from "@gojek/client/route";
import { RideSocket, type SocketState } from "@gojek/client/socket";
import type { LatLng, PaymentMethod, Place } from "@gojek/core";
import { useEffect, useMemo, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
type Session = { token: string; user: User };

export function App() {
  const [session, setSession] = useStored<Session | null>("session", null);
  const [defaultPhone] = useState(() => `0812${Math.floor(1e6 + Math.random() * 9e6)}`);
  if (!session) {
    return (
      <div className="app">
        <header className="topbar">
          <h1>RideSim · Customer</h1>
          <ResetButton api={new ApiClient(API)} onDone={wipeLocalAndReload} />
        </header>
        <div className="page">
          <LoginForm
            role="customer"
            defaultPhone={defaultPhone}
            onLogin={async (phone, name) => setSession(await new ApiClient(API).login(phone, "customer", name || undefined))}
          />
        </div>
      </div>
    );
  }
  return <Customer session={session} onLogout={() => setSession(null)} />;
}

type Tab = "ride" | "history" | "wallet";

const STATUS_TEXT: Record<string, string> = {
  REQUESTED: "Mencari driver…",
  OFFERING: "Mencari driver…",
  ACCEPTED: "Driver menuju lokasi jemput",
  ARRIVED: "Driver sudah tiba",
  ON_TRIP: "Dalam perjalanan",
  COMPLETED: "Perjalanan selesai",
  CANCELLED: "Pesanan dibatalkan",
  NO_DRIVER: "Driver tidak ditemukan",
};

function Customer({ session, onLogout }: { session: Session; onLogout: () => void }) {
  // any 401 (e.g. the simulator was reset from the other window) → back to login with clean local state
  const api = useMemo(() => new ApiClient(API, session.token, wipeLocalAndReload), [session.token]);
  useEffect(() => {
    const check = () => void api.me().catch(() => {});
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [api]);
  const [tab, setTab] = useState<Tab>("ride");
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [pickMode, setPickMode] = useState<"pickup" | "dropoff">("pickup");
  const [est, setEst] = useState<{ distanceM: number; fare: number } | null>(null);
  const [pay, setPay] = useState<PaymentMethod>("CASH");
  const [balance, setBalance] = useState<number | null>(null);
  const [ride, setRide] = useState<RideView | null>(null);
  const [driverPos, setDriverPos] = useState<LatLng | null>(null);
  /** where the driver was when the approach leg started; the road route is fetched once from here */
  const [legStart, setLegStart] = useState<LatLng | null>(null);
  const [paid, setPaid] = useState<{ paidVia: string; fare: number; balance: number } | null>(null);
  const [rated, setRated] = useState(0);
  const [sock, setSock] = useState<SocketState>("closed");
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  // restore an active ride after reload
  useEffect(() => {
    api.activeRide().then(({ ride }) => ride && setRide(ride)).catch(() => {});
    api.wallet().then((w) => setBalance(w.balance)).catch((e) => e.status === 401 && onLogout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // live socket for the current ride
  const rideId = ride?.id ?? null;
  useEffect(() => {
    if (!rideId) return;
    const s = new RideSocket({
      baseUrl: API,
      token: session.token,
      query: () => ({ rideId }),
      onState: (st) => {
        setSock(st);
        if (st === "closed") void api.me().catch(() => {}); // handshake refused? → 401 → logout
      },
      onReset: wipeLocalAndReload,
      onMessage: (m: ServerMsg) => {
        switch (m.t) {
          case "hello":
            s.send({ t: "resume", rideId });
            break;
          case "ride.status":
            if (m.rideId !== rideId) break;
            setRide(m.ride);
            if (m.status === "ACCEPTED") flash(`Driver ditemukan: ${m.driver?.name}`);
            break;
          case "driver.loc":
            if (m.rideId === rideId) setDriverPos({ lat: m.lat, lng: m.lng });
            break;
          case "ride.paid":
            setPaid({ paidVia: m.paidVia, fare: m.fare, balance: m.balance });
            setBalance(m.balance);
            break;
          case "error":
            flash(`${m.code}: ${m.message}`);
            break;
        }
      },
    });
    return () => s.close();
  }, [rideId, session.token]);

  useEffect(() => {
    setEst(null);
    if (!pickup || !dropoff) return;
    api.estimate(pickup, dropoff).then(setEst).catch((e) => flash(e.message));
  }, [api, pickup, dropoff]);

  const active = ride && !["COMPLETED", "CANCELLED", "NO_DRIVER"].includes(ride.status);
  const P = ride?.pickup ?? pickup;
  const D = ride?.dropoff ?? dropoff;

  // map focus per phase: before order = whole trip; pickup phase = driver → pickup only; on trip = → destination only
  const phase = ride?.status === "ACCEPTED" || ride?.status === "ARRIVED" ? "pickup" : ride?.status === "ON_TRIP" ? "trip" : "plan";
  const markers: MapMarker[] = [];
  if (P && phase !== "trip") markers.push({ id: "pickup", kind: "pickup", ...P, title: "Jemput" });
  if (D && phase !== "pickup") markers.push({ id: "dropoff", kind: "dropoff", ...D, title: "Tujuan" });
  if (driverPos && ride && ["ACCEPTED", "ARRIVED", "ON_TRIP"].includes(ride.status))
    markers.push({ id: "driver", kind: "driver", ...driverPos, title: ride.driver?.name });

  useEffect(() => {
    if (ride?.status === "ACCEPTED" && driverPos && !legStart) setLegStart(driverPos);
  }, [ride?.status, driverPos, legStart]);
  const trip = useRoute(P, D);
  const approach = useRoute(ride?.status === "ACCEPTED" ? legStart : null, P);
  const tripPts = trip?.points ?? (P && D ? [P, D] : []);

  let route: LatLng[] = phase === "pickup" ? [] : tripPts;
  let remainingM: number | null = null;
  if (ride?.status === "ACCEPTED" && driverPos && P) {
    route = trimFrom(approach?.points ?? [driverPos, P], driverPos);
    remainingM = pathLength(route);
  } else if (ride?.status === "ON_TRIP" && driverPos && D) {
    route = trimFrom(tripPts.length ? tripPts : [driverPos, D], driverPos);
    remainingM = pathLength(route);
  }

  const choosePreset = (id: string) => {
    const t = PRESET_TRIPS.find((p) => p.id === id);
    if (!t) return;
    setPickup(t.pickup);
    setDropoff(t.dropoff);
  };

  const order = async () => {
    if (!pickup || !dropoff) return;
    setBusy(true);
    try {
      const res = await api.createRide(pickup, dropoff, pay);
      setPaid(null);
      setRated(0);
      setDriverPos(null);
      setLegStart(null);
      setRide(res.ride);
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setRide(null);
    setPaid(null);
    setDriverPos(null);
    setLegStart(null);
    setRated(0);
    api.wallet().then((w) => setBalance(w.balance)).catch(() => {});
  };

  // re-fit when the status changes and again once road routes arrive
  const fitKey = `${ride ? `${ride.id}:${ride.status}` : `${pickup?.lat},${dropoff?.lat}`}:${trip?.source}:${approach?.source}:${!!driverPos}`;
  const fitPoints = route.length
    ? route
    : phase === "pickup"
      ? ([P, driverPos].filter(Boolean) as LatLng[])
      : ([P, D].filter(Boolean) as LatLng[]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>RideSim · Customer</h1>
        {rideId && <ConnDot state={sock} />}
        <nav className="tabs">
          {(["ride", "history", "wallet"] as Tab[]).map((t) => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
              {t === "ride" ? "Ride" : t === "history" ? "Riwayat" : "Wallet"}
            </button>
          ))}
        </nav>
        <ResetButton api={api} onDone={wipeLocalAndReload} />
        <button onClick={onLogout} title={session.user.phone}>Keluar</button>
      </header>

      {tab === "ride" && (
        <div className="body">
          <MapView
            center={PRESET_TRIPS[0]!.pickup}
            markers={markers}
            route={route}
            fitKey={fitKey}
            fitPoints={fitPoints}
            onClick={active ? undefined : (p) => {
              if (ride) reset();
              if (pickMode === "pickup") {
                setPickup({ ...p, label: "Titik jemput" });
                setPickMode("dropoff");
              } else setDropoff({ ...p, label: "Tujuan" });
            }}
          />
          <div className="sheet">
            {!ride && (
              <div className="card" data-testid="order-card">
                <div className="row between">
                  <h3>Halo, {session.user.name}</h3>
                  <span className="muted">Saldo <b data-testid="balance">{balance === null ? "…" : fmtRp(balance)}</b></span>
                </div>
                <select data-testid="preset" value="" onChange={(e) => choosePreset(e.target.value)}>
                  <option value="">Pilih rute cepat…</option>
                  {PRESET_TRIPS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <div className="seg">
                  <button aria-pressed={pickMode === "pickup"} onClick={() => setPickMode("pickup")} data-testid="pick-pickup">
                    📍 {pickup ? pickup.label ?? "Jemput" : "Set jemput"}
                  </button>
                  <button aria-pressed={pickMode === "dropoff"} onClick={() => setPickMode("dropoff")} data-testid="pick-dropoff">
                    🏁 {dropoff ? dropoff.label ?? "Tujuan" : "Set tujuan"}
                  </button>
                </div>
                <p className="muted">Klik peta untuk {pickMode === "pickup" ? "titik jemput" : "tujuan"}.</p>
                {est && (
                  <>
                    <div className="row between">
                      <span>
                        {fmtKm(trip?.source === "osrm" ? trip.distanceM : est.distanceM)}
                        {trip && <span className="muted"> · ~{Math.max(1, Math.round(trip.durationS / 60))} mnt{trip.source === "osrm" ? " via jalan" : ""}</span>}
                      </span>
                      <strong data-testid="fare">{fmtRp(est.fare)}</strong>
                    </div>
                    <div className="seg">
                      {(["CASH", "WALLET"] as PaymentMethod[]).map((m) => (
                        <button key={m} aria-pressed={pay === m} onClick={() => setPay(m)} data-testid={`pay-${m}`}>
                          {m === "CASH" ? "💵 Tunai" : "👛 Wallet"}
                        </button>
                      ))}
                    </div>
                    {pay === "WALLET" && balance !== null && balance < est.fare && (
                      <p className="err">Saldo kurang. Top-up di tab Wallet.</p>
                    )}
                  </>
                )}
                <button className="primary big" disabled={!est || busy} onClick={order} data-testid="order-button">
                  Pesan sekarang
                </button>
              </div>
            )}

            {ride && (
              <div className="card" data-testid="ride-card">
                <div className="row between">
                  <span className="status" data-testid="ride-status" data-status={ride.status}>{STATUS_TEXT[ride.status]}</span>
                  {(ride.status === "REQUESTED" || ride.status === "OFFERING") && <div className="spinner" />}
                </div>
                {ride.driver && <DriverCard d={ride.driver} />}
                {remainingM !== null && ride.status === "ACCEPTED" && (
                  <p className="muted">Driver {fmtKm(remainingM)} dari titik jemput</p>
                )}
                {remainingM !== null && ride.status === "ON_TRIP" && (
                  <p className="muted">Sisa {fmtKm(remainingM)} ke tujuan</p>
                )}
                <div className="row between">
                  <span className="muted">{ride.pickup.label} → {ride.dropoff.label}</span>
                  <span>{fmtRp(ride.fare)} · {ride.paymentMethod === "CASH" ? "Tunai" : "Wallet"}</span>
                </div>
                {["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED"].includes(ride.status) && (
                  <button
                    className="danger"
                    data-testid="cancel-button"
                    onClick={async () => {
                      try {
                        setRide((await api.cancel(ride.id, "Berubah pikiran")).ride);
                      } catch (e) {
                        flash((e as Error).message);
                      }
                    }}
                  >
                    Batalkan
                  </button>
                )}
                {ride.status === "COMPLETED" && (
                  <>
                    <div data-testid="paid-summary" data-paid-via={paid?.paidVia ?? ""}>
                      {paid ? (
                        <p>
                          Dibayar <b>{fmtRp(paid.fare)}</b> via <b>{paid.paidVia === "WALLET" ? "Wallet" : "Tunai"}</b>
                          {paid.paidVia === "WALLET" && <> · saldo {fmtRp(paid.balance)}</>}
                        </p>
                      ) : (
                        <p className="muted">Memproses pembayaran…</p>
                      )}
                      {ride.paymentMethod === "WALLET" && paid?.paidVia === "CASH" && (
                        <p className="err">Saldo tidak cukup, bayar tunai ke driver.</p>
                      )}
                    </div>
                    <div className="row between">
                      <span>Beri rating</span>
                      <div className="stars">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            data-testid={`star-${n}`}
                            disabled={rated > 0}
                            onClick={async () => {
                              await api.rate(ride.id, n).catch((e) => flash(e.message));
                              setRated(n);
                            }}
                          >
                            {n <= rated ? "★" : "☆"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {!active && (
                  <button className="primary" onClick={reset} data-testid="new-ride">Pesan lagi</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "history" && <History api={api} />}
      {tab === "wallet" && (
        <div className="page"><WalletPanel api={api} refreshKey={paid} /></div>
      )}
      <Toast text={toast} />
    </div>
  );
}

function DriverCard({ d }: { d: DriverInfo }) {
  return (
    <div className="row between">
      <div>
        <div data-testid="driver-name"><b>{d.name}</b></div>
        <div className="muted">{d.vehicle?.model} · {d.vehicle?.color}</div>
      </div>
      <span className="pill" data-testid="driver-plate">{d.vehicle?.plate}</span>
    </div>
  );
}

function History({ api }: { api: ApiClient }) {
  const [rides, setRides] = useState<RideView[] | null>(null);
  useEffect(() => {
    api.rides().then((r) => setRides(r.rides)).catch(() => setRides([]));
  }, [api]);
  return (
    <div className="page">
      <div className="card">
        <h3>Riwayat</h3>
        <ul className="list" data-testid="history">
          {rides?.length === 0 && <li className="muted">Belum ada ride</li>}
          {rides?.map((r) => (
            <li key={r.id} className="row between">
              <span>
                {r.pickup.label} → {r.dropoff.label}
                <br />
                <small className="muted">{fmtTime(r.requestedAt)} · {r.status}{r.rating ? ` · ${"★".repeat(r.rating)}` : ""}</small>
              </span>
              <span>{fmtRp(r.fareFinal ?? r.fare)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
