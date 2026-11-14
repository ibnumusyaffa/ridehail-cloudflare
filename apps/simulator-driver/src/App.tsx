import { ApiClient, type User } from "@gojek/client/api";
import { nearPickup, PRESET_TRIPS } from "@gojek/client/presets";
import type { OfferPayload, RideView, ServerMsg } from "@gojek/client/protocol";
import {
  ConnDot, fmtKm, fmtRp, fmtTime, LoginForm, MapView, type MapMarker, ResetButton, Toast, useRoute, useStored, WalletPanel, wipeLocalAndReload,
} from "@gojek/client/react";
import { advanceAlong, getRoute, pathLength, trimFrom } from "@gojek/client/route";
import { RideSocket, type SocketState } from "@gojek/client/socket";
import { type DriverStatus, haversineM, type LatLng, shouldSendPing } from "@gojek/core";
import { useEffect, useMemo, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
type Session = { token: string; user: User };

export function App() {
  const [session, setSession] = useStored<Session | null>("session", null);
  const [defaultPhone] = useState(() => `0899${Math.floor(1e6 + Math.random() * 9e6)}`);
  if (!session) {
    return (
      <div className="app">
        <header className="topbar driver">
          <h1>RideSim · Driver</h1>
          <ResetButton api={new ApiClient(API)} onDone={wipeLocalAndReload} />
        </header>
        <div className="page">
          <LoginForm
            role="driver"
            defaultPhone={defaultPhone}
            onLogin={async (phone, name) => setSession(await new ApiClient(API).login(phone, "driver", name || undefined))}
          />
        </div>
      </div>
    );
  }
  return <Driver session={session} onLogout={() => setSession(null)} />;
}

type Tab = "drive" | "earnings" | "wallet";
const ARRIVE_M = 25;

const STATUS_TEXT: Record<DriverStatus, string> = {
  OFFLINE: "Offline",
  AVAILABLE: "Online · menunggu order",
  RESERVED: "Ada tawaran!",
  ON_RIDE: "Sedang mengantar",
};

function Driver({ session, onLogout }: { session: Session; onLogout: () => void }) {
  // any 401 (e.g. the simulator was reset from the other window) → back to login with clean local state
  const api = useMemo(() => new ApiClient(API, session.token, wipeLocalAndReload), [session.token]);
  useEffect(() => {
    const check = () => void api.me().catch(() => {});
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [api]);
  const [tab, setTab] = useState<Tab>("drive");
  const [pos, setPosStored] = useStored<LatLng>("pos", nearPickup(PRESET_TRIPS[0]!));
  const [wantOnline, setWantOnline] = useStored<boolean>("wantOnline", false);
  const [autopilot, setAutopilot] = useStored<boolean>("autopilot", true);
  const [speed, setSpeed] = useStored<number>("speed", 25);
  const [status, setStatus] = useState<DriverStatus>("OFFLINE");
  const [offer, setOffer] = useState<OfferPayload | null>(null);
  const [ride, setRide] = useState<RideView | null>(null);
  const [lastPaid, setLastPaid] = useState<{ fare: number; paidVia: string; balance: number } | null>(null);
  const [sock, setSock] = useState<SocketState>("closed");
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [heading, setHeading] = useState(0);
  /** remaining road waypoints the autopilot follows to the current target */
  const [path, setPathState] = useState<LatLng[]>([]);
  const pathRef = useRef<LatLng[]>([]);
  const setPath = (p: LatLng[]) => {
    pathRef.current = p;
    setPathState(p);
  };

  // refs for socket callbacks / timers (avoid stale closures)
  const posRef = useRef(pos);
  const wantRef = useRef(wantOnline);
  const rideRef = useRef(ride);
  const sockRef = useRef<RideSocket | null>(null);
  wantRef.current = wantOnline;
  rideRef.current = ride;
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
  const setPos = (p: LatLng) => {
    posRef.current = p;
    setPosStored({ lat: p.lat, lng: p.lng });
  };
  const sendLoc = () => sockRef.current?.send({ t: "loc", lat: posRef.current.lat, lng: posRef.current.lng, heading: Math.round(heading) });

  useEffect(() => {
    const s = new RideSocket({
      baseUrl: API,
      token: session.token,
      query: () => ({ lat: posRef.current.lat.toFixed(6), lng: posRef.current.lng.toFixed(6) }),
      onState: (st) => {
        setSock(st);
        if (st === "closed") void api.me().catch(() => {}); // handshake refused? → 401 → logout
      },
      onReset: wipeLocalAndReload,
      onMessage: (m: ServerMsg) => {
        switch (m.t) {
          case "hello":
            s.send({ t: "loc", lat: posRef.current.lat, lng: posRef.current.lng });
            if (m.driverStatus === "ON_RIDE" || m.driverStatus === "RESERVED") s.send({ t: "resume", rideId: m.rideId ?? undefined });
            else if (wantRef.current) s.send({ t: "online" });
            if (m.driverStatus) setStatus(m.driverStatus);
            break;
          case "driver.state":
            setStatus(m.status);
            if (m.status !== "RESERVED") setOffer(null);
            break;
          case "offer":
            setOffer(m);
            setStatus("RESERVED");
            break;
          case "offer.cancelled":
            setOffer(null);
            flash(m.reason === "TIMEOUT" ? "Tawaran kedaluwarsa" : "Order dibatalkan customer");
            break;
          case "ride.status":
            setOffer((o) => (o?.rideId === m.rideId ? null : o));
            setRide(m.ride);
            if (m.status === "CANCELLED") flash("Ride dibatalkan");
            break;
          case "ride.paid":
            setLastPaid({ fare: m.fare, paidVia: m.paidVia, balance: m.balance });
            flash(`Ride selesai · ${m.paidVia === "WALLET" ? "via wallet" : "tunai"} · saldo ${fmtRp(m.balance)}`);
            break;
          case "zone.moved":
            flash(`Pindah zona → ${m.zone}`);
            break;
          case "error":
            flash(`${m.code}: ${m.message}`);
            if (m.code === "DRIVER_BALANCE_TOO_LOW") setWantOnline(false);
            break;
        }
      },
    });
    sockRef.current = s;
    return () => {
      s.close();
      sockRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  // restore ride after reload
  useEffect(() => {
    api.activeRide().then(({ ride }) => ride && ride.status !== "OFFERING" && setRide(ride)).catch((e) => e.status === 401 && onLogout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const target: LatLng | null =
    ride?.status === "ACCEPTED" ? ride.pickup : ride?.status === "ON_TRIP" ? ride.dropoff : null;
  const atTarget = target ? haversineM(pos, target) <= ARRIVE_M : false;
  const remaining = target ? (path.length ? pathLength([pos, ...path]) : haversineM(pos, target)) : null;

  // new leg (or autopilot switched back on): fetch the road route from where we are now
  const targetKey = target ? `${ride?.id}:${ride?.status}:${autopilot}` : "";
  useEffect(() => {
    if (!target) return setPath([]);
    setPath([target]); // straight line until the road route arrives
    let live = true;
    getRoute(posRef.current, target).then((r) => {
      if (live) setPath(trimFrom(r.points, posRef.current).slice(1));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // 1s tick: autopilot movement + location pings (throttled by distance / time)
  const lastPing = useRef<(LatLng & { at: number }) | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      const r = rideRef.current;
      const tgt = r?.status === "ACCEPTED" ? r.pickup : r?.status === "ON_TRIP" ? r.dropoff : null;
      if (tgt && autopilot && haversineM(posRef.current, tgt) > 1) {
        const step = advanceAlong(posRef.current, pathRef.current.length ? pathRef.current : [tgt], speed);
        if (step.heading !== null) setHeading(step.heading);
        setPos(step.pos);
        setPath(step.path);
      }
      // ping when moved >= 30 m or every 5 s (the server also drops pings closer than 1-2 s apart)
      const here = { ...posRef.current, at: Date.now() };
      if (shouldSendPing(lastPing.current, here, haversineM) && sendLoc()) lastPing.current = here;
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilot, speed]);

  const toggleOnline = () => {
    const next = !wantOnline;
    setWantOnline(next);
    sendLoc();
    sockRef.current?.send({ t: next ? "online" : "offline" });
  };

  const rideAction = (t: "ride.arrived" | "ride.start" | "ride.complete") => ride && sockRef.current?.send({ t, rideId: ride.id });

  const onRide = ride && ["ACCEPTED", "ARRIVED", "ON_TRIP"].includes(ride.status);
  const markers: MapMarker[] = [
    {
      id: "me",
      kind: "me",
      ...pos,
      draggable: !onRide || !autopilot,
      title: "Posisi saya (geser)",
      onDragEnd: (p) => {
        setPos(p);
        sendLoc();
      },
    },
  ];
  // offer: show the whole job; pickup phase: only the pickup; on trip: only the destination
  if (offer) {
    markers.push({ id: "pickup", kind: "pickup", ...offer.pickup });
    markers.push({ id: "dropoff", kind: "dropoff", ...offer.dropoff });
  } else if (ride && (ride.status === "ACCEPTED" || ride.status === "ARRIVED")) {
    markers.push({ id: "pickup", kind: "pickup", ...ride.pickup });
  } else if (ride?.status === "ON_TRIP") {
    markers.push({ id: "dropoff", kind: "dropoff", ...ride.dropoff });
  }
  const shown = offer ?? ride;
  const trip = useRoute(shown?.pickup, shown?.dropoff);
  const approachToOffer = useRoute(offer ? pos : null, offer?.pickup);
  const tripPts = trip?.points ?? (shown ? [shown.pickup, shown.dropoff] : []);
  const route: LatLng[] = ride?.status === "ACCEPTED" ? [pos, ...path]
    : ride?.status === "ARRIVED" ? []
    : ride?.status === "ON_TRIP" ? [pos, ...path]
    : offer ? [...(approachToOffer?.points ?? [pos, offer.pickup]), ...tripPts] : [];
  // re-fit when the leg changes and again once the road route arrives
  const fitKey = `${offer ? `offer:${offer.rideId}` : ride && onRide ? `${ride.id}:${ride.status}` : "idle"}:${trip?.source}:${approachToOffer?.source}:${path.length > 1}`;
  const fitPoints = (offer || onRide) && route.length ? route : ride?.status === "ARRIVED" ? [pos, ride.pickup] : [pos];


  return (
    <div className="app">
      <header className="topbar driver">
        <h1>RideSim · Driver</h1>
        <ConnDot state={sock} />
        <nav className="tabs">
          {(["drive", "earnings", "wallet"] as Tab[]).map((t) => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
              {t === "drive" ? "Kemudi" : t === "earnings" ? "Pendapatan" : "Wallet"}
            </button>
          ))}
        </nav>
        <ResetButton api={api} onDone={wipeLocalAndReload} />
        <button onClick={onLogout} title={session.user.phone}>Keluar</button>
      </header>

      {tab === "drive" && (
        <div className="body">
          <MapView
            center={pos}
            markers={markers}
            route={route}
            fitKey={fitKey}
            fitPoints={fitPoints}
            onClick={onRide && autopilot ? undefined : (p) => (setPos(p), sendLoc())}
          />

          <div className="sheet">
            {!onRide && (
              <div className="card">
                <div className="row between">
                  <span className="status" data-testid="driver-status" data-status={status}>{STATUS_TEXT[status]}</span>
                  <button className={wantOnline ? "" : "primary"} onClick={toggleOnline} data-testid="online-toggle" data-online={wantOnline}>
                    {wantOnline ? "Go offline" : "Go online"}
                  </button>
                </div>
                <label>
                  Pindah ke
                  <select
                    data-testid="spawn"
                    value=""
                    onChange={(e) => {
                      const t = PRESET_TRIPS.find((p) => p.id === e.target.value);
                      if (t) (setPos(nearPickup(t)), sendLoc());
                    }}
                  >
                    <option value="">Dekat… (atau klik / geser 🛵 di peta)</option>
                    {PRESET_TRIPS.map((t) => <option key={t.id} value={t.id}>{t.pickup.label}</option>)}
                  </select>
                </label>
                <p className="muted">{session.user.name} · {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</p>
                {lastPaid && ride?.status === "COMPLETED" && (
                  <p data-testid="last-paid">
                    Ride terakhir: {fmtRp(lastPaid.fare)} ({lastPaid.paidVia === "WALLET" ? "wallet" : "tunai"}) · saldo{" "}
                    <b className={lastPaid.balance < 0 ? "neg" : ""}>{fmtRp(lastPaid.balance)}</b>
                  </p>
                )}
              </div>
            )}

            {onRide && ride && (
              <div className="card" data-testid="ride-card">
                <div className="row between">
                  <span className="status" data-testid="driver-ride-status" data-status={ride.status}>
                    {ride.status === "ACCEPTED" ? "Menuju jemput" : ride.status === "ARRIVED" ? "Menunggu customer" : "Antar ke tujuan"}
                  </span>
                  <span className="pill">{fmtRp(ride.fare)} · {ride.paymentMethod === "CASH" ? "Tunai" : "Wallet"}</span>
                </div>
                <p className="muted">{ride.pickup.label} → {ride.dropoff.label}</p>
                {remaining !== null && (
                  <p data-testid="nav" data-remaining={Math.round(remaining)} data-at-target={atTarget}>
                    {atTarget ? "✅ Sudah sampai" : `Sisa ${fmtKm(remaining)}${path.length > 1 ? " via jalan" : ""}`}
                  </p>
                )}
                <div className="row gap">
                  <label className="row gap" style={{ color: "inherit" }}>
                    <input type="checkbox" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} data-testid="autopilot" />
                    Autopilot
                  </label>
                  <input type="range" min={5} max={150} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="speed" />
                  <span className="muted">{speed} m/s</span>
                </div>
                {ride.status === "ACCEPTED" && (
                  <button className="primary big" onClick={() => rideAction("ride.arrived")} data-testid="ride-arrived">Sudah tiba</button>
                )}
                {ride.status === "ARRIVED" && (
                  <button className="primary big" onClick={() => rideAction("ride.start")} data-testid="ride-start">Mulai perjalanan</button>
                )}
                {ride.status === "ON_TRIP" && (
                  <button className="primary big" onClick={() => rideAction("ride.complete")} data-testid="ride-complete">Selesaikan</button>
                )}
                {(ride.status === "ACCEPTED" || ride.status === "ARRIVED") && (
                  <button
                    className="danger"
                    data-testid="ride-cancel"
                    onClick={async () => {
                      const reason = prompt("Alasan batal?", "Kendaraan bermasalah");
                      if (!reason) return;
                      try {
                        // the ride is not ours anymore: it goes back to the search for another driver
                        await api.cancel(ride.id, reason);
                        setRide(null);
                        flash("Ride dilepas, dicarikan driver lain");
                      } catch (e) {
                        flash((e as Error).message);
                      }
                    }}
                  >
                    Batalkan (dengan alasan)
                  </button>
                )}
              </div>
            )}
          </div>

          {offer && (
            <div className="offer">
              <div className="card" data-testid="offer" data-ride-id={offer.rideId}>
                <h3>Order baru!</h3>
                <div className="countdown">
                  <div style={{ width: `${Math.max(0, Math.min(100, ((offer.expiresAt - now) / 15_000) * 100))}%` }} />
                </div>
                <p className="muted" data-testid="offer-countdown">{Math.max(0, Math.ceil((offer.expiresAt - now) / 1000))} detik</p>
                <div className="row between">
                  <span>📍 {offer.pickup.label}</span>
                  <span className="muted">{fmtKm(haversineM(pos, offer.pickup))} dari kamu</span>
                </div>
                <div>🏁 {offer.dropoff.label} <span className="muted">({fmtKm(offer.distanceM)})</span></div>
                <div className="row between">
                  <strong>{fmtRp(offer.fare)}</strong>
                  <span className="pill">{offer.paymentMethod === "CASH" ? "Tunai" : "Wallet"}</span>
                </div>
                <div className="grid2">
                  <button data-testid="offer-reject" onClick={() => (sockRef.current?.send({ t: "offer.reject", rideId: offer.rideId }), setOffer(null))}>
                    Tolak
                  </button>
                  <button className="primary" data-testid="offer-accept" onClick={() => sockRef.current?.send({ t: "offer.accept", rideId: offer.rideId })}>
                    Terima
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "earnings" && <Earnings api={api} refreshKey={lastPaid} />}
      {tab === "wallet" && <div className="page"><WalletPanel api={api} refreshKey={lastPaid} /></div>}
      <Toast text={toast} />
    </div>
  );
}

function Earnings({ api, refreshKey }: { api: ApiClient; refreshKey: unknown }) {
  const [data, setData] = useState<Awaited<ReturnType<ApiClient["rides"]>> | null>(null);
  useEffect(() => {
    api.rides().then(setData).catch(() => {});
  }, [api, refreshKey]);
  return (
    <div className="page">
      <div className="card">
        <h3>Hari ini</h3>
        <div className="grid2">
          <div><div className="muted">Ride</div><b data-testid="today-count">{data?.today?.count ?? 0}</b></div>
          <div><div className="muted">Pendapatan bersih</div><b>{fmtRp(data?.today?.net ?? 0)}</b></div>
        </div>
      </div>
      <div className="card">
        <h3>Riwayat</h3>
        <ul className="list">
          {data?.rides.length === 0 && <li className="muted">Belum ada ride</li>}
          {data?.rides.map((r) => (
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
