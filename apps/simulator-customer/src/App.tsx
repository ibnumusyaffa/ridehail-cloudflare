import { ApiClient, ApiError, type User } from "@gojek/client/api";
import { env } from "@gojek/client/env";
import { reverseGeocode } from "@gojek/client/geocode";
import { JAKARTA, PRESET_TRIPS } from "@gojek/client/presets";
import type { DriverInfo, RideView, ServerMsg } from "@gojek/client/protocol";
import {
  AccountPage, ConnDot, RideDetail, fmtKm, fmtRp, fmtTime, Icon, initials, LoginForm, MapView, type MapMarker, Page, Phone, Sheet, PlaceSearch, ResetButton, Section, TabBar,
  type TabSpec, Toast, useRoute, useStored, WalletPanel, wipeLocalAndReload,
} from "@gojek/client/react";
import { pathLength, trimFrom } from "@gojek/client/route";
import { RideSocket, type SocketState } from "@gojek/client/socket";
import type { LatLng, PaymentMethod, Place } from "@gojek/core";
import { useEffect, useMemo, useRef, useState } from "react";

const API = env.VITE_API_URL;
type Session = { token: string; user: User };

export function App() {
  const [session, setSession] = useStored<Session | null>("session", null);
  const [defaultPhone] = useState(() => `0812${Math.floor(1e6 + Math.random() * 9e6)}`);
  if (!session) {
    return (
      <Phone role="customer">
        <div className="app no-tabs">
          <div className="page">
            <LoginForm
              role="customer"
              defaultPhone={defaultPhone}
              onLogin={async (phone, name) => setSession(await new ApiClient(API).login(phone, "customer", name || undefined))}
            />
            <Section>
              <ResetButton api={new ApiClient(API)} onDone={wipeLocalAndReload} />
            </Section>
          </div>
        </div>
      </Phone>
    );
  }
  return <Customer session={session} onLogout={() => setSession(null)} />;
}

type Tab = "ride" | "history" | "wallet" | "account";
const TABS: TabSpec<Tab>[] = [
  { id: "ride", label: "Ride", icon: "car" },
  { id: "history", label: "History", icon: "clock" },
  { id: "wallet", label: "Wallet", icon: "wallet" },
  { id: "account", label: "Account", icon: "person" },
];

const STATUS_TEXT: Record<string, string> = {
  REQUESTED: "Searching for a driver…",
  OFFERING: "Searching for a driver…",
  ACCEPTED: "Driver is on the way",
  ARRIVED: "Driver has arrived",
  ON_TRIP: "On the trip",
  COMPLETED: "Trip completed",
  CANCELLED: "Order cancelled",
  NO_DRIVER: "No driver found",
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
  /** address search sheet open for this point (null = closed) */
  const [searchFor, setSearchFor] = useState<"pickup" | "dropoff" | null>(null);
  const [est, setEst] = useState<{ distanceM: number; fare: number } | null>(null);
  const [pay, setPay] = useState<PaymentMethod>("CASH");
  const [balance, setBalance] = useState<number | null>(null);
  const [ride, setRide] = useState<RideView | null>(null);
  const [driverPos, setDriverPos] = useState<LatLng | null>(null);
  /** where the driver was when the approach leg started; the road route is fetched once from here */
  const [legStart, setLegStart] = useState<LatLng | null>(null);
  /** the driver went silent mid-trip: the server asks what happened (null = not asked / driver back) */
  const [lost, setLost] = useState<{ lastSeenAt: number; autoCancelAt: number } | null>(null);
  const [paid, setPaid] = useState<{ paidVia: string; fare: number; balance: number } | null>(null);
  const [rated, setRated] = useState(0);
  const [sock, setSock] = useState<SocketState>("closed");
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /**
   * Idempotency-Key of the order being placed: kept across presses of "Order" until one succeeds, so a
   * press after a lost reply gets that ride back instead of ordering again. A new trip gets a new key.
   */
  const orderKey = useRef<string | null>(null);
  useEffect(() => {
    orderKey.current = null;
  }, [pickup, dropoff, pay]);

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
            if (m.status !== "ON_TRIP") setLost(null);
            if (m.status === "ACCEPTED") flash(`Driver found: ${m.driver?.name}`);
            break;
          case "driver.loc":
            if (m.rideId === rideId) setDriverPos({ lat: m.lat, lng: m.lng });
            break;
          case "ride.driver_lost":
            if (m.rideId === rideId) setLost({ lastSeenAt: m.lastSeenAt, autoCancelAt: m.autoCancelAt });
            break;
          case "ride.requeued":
            if (m.rideId === rideId) {
              setDriverPos(null);
              flash("Driver cancelled, searching for another driver…");
            }
            break;
          case "ride.driver_back":
            if (m.rideId === rideId) {
              setLost(null);
              flash("Driver reconnected");
            }
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

  // balance chip on the order sheet: refresh when coming back from the wallet tab
  useEffect(() => {
    if (tab === "ride") api.wallet().then((w) => setBalance(w.balance)).catch(() => {});
  }, [api, tab]);

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
  if (P && phase !== "trip") markers.push({ id: "pickup", kind: "pickup", ...P, title: "Pickup" });
  if (D && phase !== "pickup") markers.push({ id: "dropoff", kind: "dropoff", ...D, title: "Destination" });
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

  /** set pickup/dropoff; a point without a name (map tap) gets one from the reverse geocoder */
  const setPoint = (which: "pickup" | "dropoff", p: Place, named: boolean) => {
    if (ride) reset();
    const set = which === "pickup" ? setPickup : setDropoff;
    set(p);
    if (!named)
      void reverseGeocode(p).then((hit) => hit && set((cur) => (cur && cur.lat === p.lat && cur.lng === p.lng ? { ...cur, label: hit.label } : cur)));
  };

  const choosePreset = (id: string) => {
    const t = PRESET_TRIPS.find((p) => p.id === id);
    if (!t) return;
    setPickup(t.pickup);
    setDropoff(t.dropoff);
  };

  const order = async () => {
    if (!pickup || !dropoff) return;
    setBusy(true);
    const show = (r: RideView) => {
      orderKey.current = null;
      setPaid(null);
      setRated(0);
      setDriverPos(null);
      setLegStart(null);
      setRide(r);
    };
    try {
      orderKey.current ??= crypto.randomUUID();
      show((await api.createRide(pickup, dropoff, pay, orderKey.current)).ride);
    } catch (e) {
      // an earlier order of ours did go through (its reply was lost): show that ride instead of an error
      const active = e instanceof ApiError && e.code === "ACTIVE_RIDE_EXISTS" ? await api.activeRide().catch(() => null) : null;
      if (active?.ride) {
        show(active.ride);
        flash("Your earlier order already went through");
      } else flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const answerLost = async (action: "arrived" | "cancel") => {
    if (!ride) return;
    try {
      setRide((await api.driverLost(ride.id, action)).ride);
      setLost(null);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const reset = () => {
    setLost(null);
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

  const searching = ride?.status === "REQUESTED" || ride?.status === "OFFERING";

  return (
    <Phone role="customer">
      <div className="app">
        {tab === "ride" && (
          <div className="body">
            <MapView
              center={PRESET_TRIPS[0]!.pickup}
              markers={markers}
              route={route}
              fitKey={fitKey}
              fitPoints={fitPoints}
              onClick={active ? undefined : (p) => {
                if (pickMode === "pickup") {
                  setPoint("pickup", { ...p, label: "Pickup point" }, false);
                  setPickMode("dropoff");
                } else setPoint("dropoff", { ...p, label: "Destination" }, false);
              }}
            />
            <div className="float-top">
              <span className="chip">
                {rideId ? <ConnDot state={sock} /> : <Icon name="pin" size={16} />}
                {ride ? STATUS_TEXT[ride.status] : `Tap the map: ${pickMode === "pickup" ? "pickup" : "destination"}`}
              </span>
            </div>
            <Sheet expandKey={ride ? `${ride.id}:${ride.status}` : "plan"}>
              {!ride && (
                <div className="card" data-testid="order-card">
                  <div className="row between order-head">
                    <div className="grow">
                      <p className="hello">Hi, {session.user.name.split(" ")[0]}</p>
                      <h2 className="title2">Where to?</h2>
                    </div>
                    <span className="pill tnum"><Icon name="wallet" size={14} /><b data-testid="balance">{balance === null ? "…" : fmtRp(balance)}</b></span>
                  </div>
                  <div className="group edge">
                    <button className="cell inset" aria-pressed={pickMode === "pickup"} onClick={() => (setPickMode("pickup"), setSearchFor("pickup"))} data-testid="pick-pickup">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin pick" /></span>
                      <span className="grow">
                        <span className="sub" style={{ display: "block" }}>Pickup</span>
                        {pickup ? pickup.label ?? "Pickup point" : <span className="muted">Search pickup point</span>}
                      </span>
                    </button>
                    <button className="cell inset" aria-pressed={pickMode === "dropoff"} onClick={() => (setPickMode("dropoff"), setSearchFor("dropoff"))} data-testid="pick-dropoff">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin drop" /></span>
                      <span className="grow">
                        <span className="sub" style={{ display: "block" }}>Destination</span>
                        {dropoff ? dropoff.label ?? "Destination" : <span className="muted">Search destination</span>}
                      </span>
                    </button>
                    <label className="cell inset">
                      <span className="ic indigo"><Icon name="bolt" /></span>
                      <span>Quick route</span>
                      <select data-testid="preset" value="" onChange={(e) => choosePreset(e.target.value)}>
                        <option value="">Choose…</option>
                        {PRESET_TRIPS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <span className="chev"><Icon name="chevron" size={14} /></span>
                    </label>
                  </div>
                  {est && (
                    <>
                      <div className="group">
                        <div className="cell">
                          <span className="ic green"><Icon name="car" /></span>
                          <div className="grow">
                            <div style={{ fontWeight: 600 }}>RideSim Motor</div>
                            <div className="sub">
                              {fmtKm(trip?.source === "osrm" ? trip.distanceM : est.distanceM)}
                              {trip && <> · ~{Math.max(1, Math.round(trip.durationS / 60))} min{trip.source === "osrm" ? " by road" : ""}</>}
                            </div>
                          </div>
                          <strong className="tnum" data-testid="fare">{fmtRp(est.fare)}</strong>
                        </div>
                      </div>
                      <div className="seg">
                        {(["CASH", "WALLET"] as PaymentMethod[]).map((m) => (
                          <button key={m} aria-pressed={pay === m} onClick={() => setPay(m)} data-testid={`pay-${m}`}>
                            {m === "CASH" ? "Cash" : "Wallet"}
                          </button>
                        ))}
                      </div>
                      {pay === "WALLET" && balance !== null && balance < est.fare && (
                        <p className="err">Not enough balance. Top up in the Wallet tab.</p>
                      )}
                    </>
                  )}
                  <button className="primary big" disabled={!est || busy} onClick={order} data-testid="order-button">
                    {busy ? "Ordering…" : est ? `Order · ${fmtRp(est.fare)}` : "Order now"}
                  </button>
                </div>
              )}

              {ride && (
                <div className="card" data-testid="ride-card">
                  <div className="row between" style={{ gap: 12 }}>
                    <div>
                      <span className="status" data-testid="ride-status" data-status={ride.status}>{STATUS_TEXT[ride.status]}</span>
                      {remainingM !== null && ride.status === "ACCEPTED" && (
                        <p className="muted">Driver is {fmtKm(remainingM)} from pickup</p>
                      )}
                      {remainingM !== null && ride.status === "ON_TRIP" && (
                        <p className="muted">{fmtKm(remainingM)} to destination</p>
                      )}
                      {searching && <p className="muted">Contacting nearby drivers</p>}
                    </div>
                    {searching && <div className="spinner" />}
                  </div>
                  {ride.driver && <DriverCard d={ride.driver} />}
                  {/* once completed, the paid summary says what matters: keep the sheet short so the rating and "Order again" fit */}
                  {ride.status !== "COMPLETED" && <div className="group">
                    <div className="cell inset">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin pick" /></span>
                      <span className="grow">{ride.pickup.label}</span>
                    </div>
                    <div className="cell inset">
                      <span style={{ width: 30, display: "grid", placeItems: "center" }}><span className="dotpin drop" /></span>
                      <span className="grow">{ride.dropoff.label}</span>
                    </div>
                    <div className="cell inset">
                      <span className="ic gray"><Icon name="wallet" /></span>
                      <span className="grow">{ride.paymentMethod === "CASH" ? "Cash" : "Wallet"}</span>
                      <strong className="tnum">{fmtRp(ride.fare)}</strong>
                    </div>
                  </div>}
                  {lost && ride.status === "ON_TRIP" && (
                    <div className="stack" data-testid="driver-lost">
                      <Section foot={`Cancels automatically at ${fmtTime(lost.autoCancelAt)} if you don't answer.`}>
                        <div className="cell">
                          <span className="ic orange">!</span>
                          <span className="grow">Driver's phone offline since {fmtTime(lost.lastSeenAt)}. How's the trip?</span>
                        </div>
                        <button className="cell accent" data-testid="lost-arrived" onClick={() => answerLost("arrived")}>Arrived</button>
                        <button className="cell accent" data-testid="lost-ongoing" onClick={() => setLost(null)}>Still riding</button>
                        <button className="cell destructive" style={{ justifyContent: "flex-start" }} data-testid="lost-cancel" onClick={() => answerLost("cancel")}>Something's wrong</button>
                      </Section>
                    </div>
                  )}
                  {["REQUESTED", "OFFERING", "ACCEPTED", "ARRIVED"].includes(ride.status) && (
                    <div className="sheet-cta"><button
                      className="danger big"
                      data-testid="cancel-button"
                      onClick={async () => {
                        try {
                          setRide((await api.cancel(ride.id, "Changed my mind")).ride);
                        } catch (e) {
                          flash((e as Error).message);
                        }
                      }}
                    >
                      Cancel order
                    </button></div>
                  )}
                  {ride.status === "COMPLETED" && (
                    <div className="group">
                      <div className="cell" data-testid="paid-summary" data-paid-via={paid?.paidVia ?? ""}>
                        <span className="ic green">✓</span>
                        <div className="grow">
                          {paid ? (
                            <>
                              <div>Paid <b className="tnum">{fmtRp(paid.fare)}</b> via {paid.paidVia === "WALLET" ? "Wallet" : "Cash"}</div>
                              {paid.paidVia === "WALLET" && <div className="sub">Balance {fmtRp(paid.balance)}</div>}
                              {ride.paymentMethod === "WALLET" && paid.paidVia === "CASH" && (
                                <div className="err">Not enough balance, pay the driver in cash.</div>
                              )}
                            </>
                          ) : (
                            <span className="muted">Processing payment…</span>
                          )}
                        </div>
                      </div>
                      <div className="cell" style={{ flexDirection: "column", gap: 4, paddingBlock: 14 }}>
                        <span className="muted">{rated ? "Thank you!" : `How was your trip with ${ride.driver?.name ?? "the driver"}?`}</span>
                        <div className="stars">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              data-testid={`star-${n}`}
                              disabled={rated > 0}
                              aria-label={`${n} stars`}
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
                    </div>
                  )}
                  {!active && (
                    <div className="sheet-cta"><button className="primary big" onClick={reset} data-testid="new-ride">Order again</button></div>
                  )}
                </div>
              )}
            </Sheet>
          </div>
        )}

        {tab === "ride" && searchFor && (
          <PlaceSearch
            key={searchFor}
            title={searchFor === "pickup" ? "Pickup point" : "Destination"}
            near={pickup ?? JAKARTA}
            onClose={() => setSearchFor(null)}
            onMap={() => (setPickMode(searchFor), setSearchFor(null))}
            onPick={(h) => {
              setPoint(searchFor, { lat: h.lat, lng: h.lng, label: h.label }, true);
              // pickup first, then straight on to the destination like a real ride app
              if (searchFor === "pickup" && !dropoff) {
                setPickMode("dropoff");
                setSearchFor("dropoff");
              } else setSearchFor(null);
            }}
          />
        )}
        {tab === "history" && <History api={api} />}
        {tab === "wallet" && <Page title="Wallet"><WalletPanel api={api} refreshKey={paid} /></Page>}
        {tab === "account" && <AccountPage user={session.user} role="customer" api={api} onLogout={onLogout} />}
        <TabBar tabs={TABS} value={tab} onChange={setTab} />
      </div>
      <Toast text={toast} />
    </Phone>
  );
}

function DriverCard({ d }: { d: DriverInfo }) {
  return (
    <div className="group">
      <div className="cell">
        <div className="avatar">{initials(d.name)}</div>
        <div className="grow">
          <div data-testid="driver-name" style={{ fontWeight: 600 }}>{d.name}</div>
          <div className="sub">{d.vehicle?.model} · {d.vehicle?.color}</div>
        </div>
        <span className="plate" data-testid="driver-plate">{d.vehicle?.plate}</span>
      </div>
    </div>
  );
}

const HIST_STATUS: Record<string, string> = { COMPLETED: "Completed", CANCELLED: "Cancelled", NO_DRIVER: "No driver" };

function History({ api }: { api: ApiClient }) {
  const [rides, setRides] = useState<RideView[] | null>(null);
  const [open, setOpen] = useState<RideView | null>(null);
  useEffect(() => {
    api.rides().then((r) => setRides(r.rides)).catch(() => setRides([]));
  }, [api]);
  return (
    <Page title="History">
      <Section>
        <ul className="list" data-testid="history">
          {rides === null && <li className="cell muted">Loading…</li>}
          {rides?.length === 0 && <li className="cell muted">No rides yet</li>}
          {rides?.map((r) => (
            <li key={r.id}>
              <button className="cell inset" onClick={() => setOpen(r)} data-testid={`history-item-${r.id}`}>
                <span className={`ic ${r.status === "COMPLETED" ? "green" : "gray"}`}><Icon name="car" /></span>
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
          role="customer"
          api={api}
          onClose={() => setOpen(null)}
          onChange={(nr) => setRides((rs) => rs?.map((x) => (x.id === nr.id ? nr : x)) ?? rs)}
        />
      )}
    </Page>
  );
}
