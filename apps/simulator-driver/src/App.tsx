import { ApiClient, type User } from "@gojek/client/api";
import { env } from "@gojek/client/env";
import { nearPickup, PRESET_TRIPS } from "@gojek/client/presets";
import type { OfferPayload, RideView, ServerMsg } from "@gojek/client/protocol";
import {
  AccountPage, ConnDot, fmtKm, fmtRp, fmtTime, Icon, LoginForm, RideDetail, MapView, type MapMarker, Page, Phone, Sheet, ResetButton, Section, TabBar,
  type TabSpec, Toast, useRoute, useStored, WalletPanel, wipeLocalAndReload,
} from "@gojek/client/react";
import { advanceAlong, getRoute, pathLength, trimFrom } from "@gojek/client/route";
import { RideSocket, type SocketState } from "@gojek/client/socket";
import { type DriverStatus, haversineM, type LatLng, shouldSendPing } from "@gojek/core";
import { useEffect, useMemo, useRef, useState } from "react";

const API = env.VITE_API_URL;
type Session = { token: string; user: User };

export function App() {
  const [session, setSession] = useStored<Session | null>("session", null);
  const [defaultPhone] = useState(() => `0899${Math.floor(1e6 + Math.random() * 9e6)}`);
  if (!session) {
    return (
      <Phone role="driver">
        <div className="app no-tabs">
          <div className="page">
            <LoginForm
              role="driver"
              defaultPhone={defaultPhone}
              onLogin={async (phone, name) => setSession(await new ApiClient(API).login(phone, "driver", name || undefined))}
            />
            <Section>
              <ResetButton api={new ApiClient(API)} onDone={wipeLocalAndReload} />
            </Section>
          </div>
        </div>
      </Phone>
    );
  }
  return <Driver session={session} onLogout={() => setSession(null)} />;
}

type Tab = "drive" | "earnings" | "wallet" | "account";
const TABS: TabSpec<Tab>[] = [
  { id: "drive", label: "Kemudi", icon: "wheel" },
  { id: "earnings", label: "Pendapatan", icon: "chart" },
  { id: "wallet", label: "Wallet", icon: "wallet" },
  { id: "account", label: "Akun", icon: "person" },
];
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
            // a zone hand-over brings the driver over AVAILABLE: only an OFFLINE driver has to go online again
            else if (wantRef.current && m.driverStatus !== "AVAILABLE") s.send({ t: "online" });
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
      // ping when moved >= 30 m or every 10 s (the server keeps a still driver's ping every 8 s, 1 s on a ride)
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


  const online = status !== "OFFLINE";

  return (
    <Phone role="driver">
      <div className="app">
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
            <div className="float-top">
              <span className="chip"><ConnDot state={sock} />{online ? "Online" : "Offline"}</span>
            </div>

            <Sheet expandKey={ride && onRide ? `${ride.id}:${ride.status}` : `idle:${status}`}>
              {!onRide && (
                <div className="card">
                  <div className="row between" style={{ gap: 12 }}>
                    <div>
                      <span className="status" data-testid="driver-status" data-status={status}>{STATUS_TEXT[status]}</span>
                      <p className="muted">{session.user.name}</p>
                    </div>
                    <span className={`dot ${online ? "dot-open" : ""}`} style={{ width: 12, height: 12, background: online ? undefined : "#8e8e93" }} />
                  </div>
                  <button className={`big ${wantOnline ? "danger" : "primary"}`} onClick={toggleOnline} data-testid="online-toggle" data-online={wantOnline}>
                    {wantOnline ? "Go offline" : "Go online"}
                  </button>
                  <Section foot="Atau klik peta / geser 🛵 untuk pindah posisi.">
                    <label className="cell inset">
                      <span className="ic blue"><Icon name="pin" /></span>
                      <span>Pindah ke dekat</span>
                      <select
                        data-testid="spawn"
                        value=""
                        onChange={(e) => {
                          const t = PRESET_TRIPS.find((p) => p.id === e.target.value);
                          if (t) (setPos(nearPickup(t)), sendLoc());
                        }}
                      >
                        <option value="">Pilih…</option>
                        {PRESET_TRIPS.map((t) => <option key={t.id} value={t.id}>{t.pickup.label}</option>)}
                      </select>
                      <span className="chev"><Icon name="chevron" size={14} /></span>
                    </label>
                    <div className="cell inset">
                      <span className="ic gray"><Icon name="bolt" /></span>
                      <span className="grow">Koordinat</span>
                      <span className="value tnum small">{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</span>
                    </div>
                  </Section>
                  {lastPaid && ride?.status === "COMPLETED" && (
                    <div className="group">
                      <div className="cell" data-testid="last-paid">
                        <span className="ic green">✓</span>
                        <div className="grow">
                          <div>Ride terakhir {fmtRp(lastPaid.fare)} ({lastPaid.paidVia === "WALLET" ? "wallet" : "tunai"})</div>
                          <div className="sub">Saldo <b className={lastPaid.balance < 0 ? "neg" : ""}>{fmtRp(lastPaid.balance)}</b></div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {onRide && ride && (
                <div className="card" data-testid="ride-card">
                  <div className="row between" style={{ gap: 12 }}>
                    <div>
                      <span className="status" data-testid="driver-ride-status" data-status={ride.status}>
                        {ride.status === "ACCEPTED" ? "Menuju jemput" : ride.status === "ARRIVED" ? "Menunggu customer" : "Antar ke tujuan"}
                      </span>
                      {remaining !== null && (
                        <p className="muted" data-testid="nav" data-remaining={Math.round(remaining)} data-at-target={atTarget}>
                          {atTarget ? "✅ Sudah sampai" : `Sisa ${fmtKm(remaining)}${path.length > 1 ? " via jalan" : ""}`}
                        </p>
                      )}
                    </div>
                    <span className="pill tnum">{fmtRp(ride.fare)} · {ride.paymentMethod === "CASH" ? "Tunai" : "Wallet"}</span>
                  </div>
                  <div className="group">
                    <div className="cell inset">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin pick" /></span>
                      <span className="grow">{ride.pickup.label}</span>
                    </div>
                    <div className="cell inset">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin drop" /></span>
                      <span className="grow">{ride.dropoff.label}</span>
                    </div>
                  </div>
                  <div className="group">
                    <label className="cell inset">
                      <span className="ic indigo"><Icon name="car" /></span>
                      <span className="grow" style={{ color: "var(--text)" }}>Autopilot</span>
                      <input type="checkbox" className="switch" role="switch" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} data-testid="autopilot" />
                    </label>
                    <div className="cell inset">
                      <span className="ic orange"><Icon name="bolt" /></span>
                      <input type="range" min={5} max={150} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="speed" aria-label="Kecepatan" />
                      <span className="value tnum small" style={{ width: 56, textAlign: "right" }}>{speed} m/s</span>
                    </div>
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
                      className="danger big"
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
            </Sheet>

            {offer && (
              <div className="offer">
                <div className="card" data-testid="offer" data-ride-id={offer.rideId}>
                  <div className="row between">
                    <h3 className="title2">Order baru</h3>
                    <span className="pill tnum" data-testid="offer-countdown">{Math.max(0, Math.ceil((offer.expiresAt - now) / 1000))} dtk</span>
                  </div>
                  <div className="countdown">
                    <div style={{ width: `${Math.max(0, Math.min(100, ((offer.expiresAt - now) / 15_000) * 100))}%` }} />
                  </div>
                  <div className="group">
                    <div className="cell inset">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin pick" /></span>
                      <div className="grow">
                        <div>{offer.pickup.label}</div>
                        <div className="sub">{fmtKm(haversineM(pos, offer.pickup))} dari kamu</div>
                      </div>
                    </div>
                    <div className="cell inset">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin drop" /></span>
                      <div className="grow">
                        <div>{offer.dropoff.label}</div>
                        <div className="sub">Perjalanan {fmtKm(offer.distanceM)}</div>
                      </div>
                    </div>
                    <div className="cell inset">
                      <span className="ic green"><Icon name="wallet" /></span>
                      <span className="grow">{offer.paymentMethod === "CASH" ? "Tunai" : "Wallet"}</span>
                      <strong className="title3 tnum">{fmtRp(offer.fare)}</strong>
                    </div>
                  </div>
                  <div className="grid2">
                    <button className="big" data-testid="offer-reject" onClick={() => (sockRef.current?.send({ t: "offer.reject", rideId: offer.rideId }), setOffer(null))}>
                      Tolak
                    </button>
                    <button className="primary big" data-testid="offer-accept" onClick={() => sockRef.current?.send({ t: "offer.accept", rideId: offer.rideId })}>
                      Terima
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "earnings" && <Earnings api={api} refreshKey={lastPaid} />}
        {tab === "wallet" && <Page title="Wallet"><WalletPanel api={api} refreshKey={lastPaid} /></Page>}
        {tab === "account" && <AccountPage user={session.user} role="driver" api={api} onLogout={onLogout} />}
        <TabBar tabs={TABS} value={tab} onChange={setTab} />
      </div>
      <Toast text={toast} />
    </Phone>
  );
}

const HIST_STATUS: Record<string, string> = { COMPLETED: "Selesai", CANCELLED: "Dibatalkan", NO_DRIVER: "Tidak ada driver" };

function Earnings({ api, refreshKey }: { api: ApiClient; refreshKey: unknown }) {
  const [data, setData] = useState<Awaited<ReturnType<ApiClient["rides"]>> | null>(null);
  const [open, setOpen] = useState<RideView | null>(null);
  useEffect(() => {
    api.rides().then(setData).catch(() => {});
  }, [api, refreshKey]);
  return (
    <Page title="Pendapatan">
      <section className="section">
        <div className="section-head">Hari ini</div>
        <div className="grid2">
          <div className="stat"><span className="muted small">Ride</span><b className="tnum" data-testid="today-count">{data?.today?.count ?? 0}</b></div>
          <div className="stat"><span className="muted small">Bersih</span><b className="tnum">{fmtRp(data?.today?.net ?? 0)}</b></div>
        </div>
      </section>
      <Section head="Riwayat">
        <ul className="list" data-testid="history">
          {data?.rides.length === 0 && <li className="cell muted">Belum ada ride</li>}
          {data?.rides.map((r) => (
            <li key={r.id}>
              <button className="cell inset" onClick={() => setOpen(r)} data-testid={`history-item-${r.id}`}>
                <span className={`ic ${r.status === "COMPLETED" ? "orange" : "gray"}`}><Icon name="wheel" /></span>
                <div className="grow">
                  <div>{r.pickup.label} → {r.dropoff.label}</div>
                  <div className="sub">{fmtTime(r.requestedAt)} · {HIST_STATUS[r.status] ?? r.status}{r.rating ? ` · ${"★".repeat(r.rating)}` : ""}</div>
                </div>
                <span className="tnum">{fmtRp(r.fareFinal ?? r.fare)}</span>
                <span className="chev"><Icon name="chevron" size={14} /></span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      {open && (
        <RideDetail
          ride={open}
          role="driver"
          api={api}
          commissionRate={data?.commissionRate}
          onClose={() => setOpen(null)}
          onChange={(nr) => setData((d) => (d ? { ...d, rides: d.rides.map((x) => (x.id === nr.id ? nr : x)) } : d))}
        />
      )}
    </Page>
  );
}
