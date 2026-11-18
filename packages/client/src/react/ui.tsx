import type { LatLng, Role } from "@gojek/core";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient, WalletTx } from "../api";
import { knownPlaces, type PlaceHit, searchPlaces } from "../geocode";
import { getRoute, type Route } from "../route";

export const fmtRp = (n: number) => `Rp${Math.round(n).toLocaleString("id-ID")}`;
export const fmtKm = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
export const fmtTime = (t: number) => new Date(t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

export function useStored<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : init;
    } catch {
      return init;
    }
  });
  const set = (nv: T) => {
    setV(nv);
    try {
      if (nv === null || nv === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(nv));
    } catch {
      /* storage blocked */
    }
  };
  return [v, set];
}

/* ---------- icons (SF Symbols-like, stroke = currentColor) ---------- */

const ICONS: Record<string, React.ReactNode> = {
  car: (<><path d="M4 16.5V13l1.8-4.6A2 2 0 0 1 7.7 7h8.6a2 2 0 0 1 1.9 1.4L20 13v3.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" /><path d="M4 13h16" /><circle cx="7.5" cy="15" r=".6" fill="currentColor" /><circle cx="16.5" cy="15" r=".6" fill="currentColor" /><path d="M6 17.5V19M18 17.5V19" /></>),
  wheel: (<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /><path d="M12 14.5V21M9.6 11.3 3.3 9.6M14.4 11.3l6.3-1.7" /></>),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>),
  chart: (<><path d="M5 20v-7M10 20V5M15 20v-9M20 20V8" /></>),
  wallet: (<><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18M16 14.5h2" /></>),
  person: (<><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>),
  chevron: (<path d="m9 5 7 7-7 7" />),
  refresh: (<><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></>),
  logout: (<><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 8l-4 4 4 4M6 12h10" /></>),
  phone: (<path d="M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" />),
  pin: (<><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></>),
  bolt: (<path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />),
  search: (<><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.8-4.8" /></>),
  map: (<><path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2Z" /><path d="M9 4v14M15 6v14" /></>),
  xmark: (<path d="m7 7 10 10M17 7 7 17" />),
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

/* ---------- device shell ---------- */

function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="statusbar">
      <span className="tnum">{now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }).replace(".", ":")}</span>
      <span className="sb-icons">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden>
          <rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor" aria-hidden>
          <path d="M8 2.5c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 8 1 10 10 0 0 0 .9 3.8L2 4.9a8.5 8.5 0 0 1 6-2.4Zm0 3.2c1.4 0 2.7.5 3.7 1.4l1.1-1.1A7 7 0 0 0 8 4.2 7 7 0 0 0 3.2 6l1.1 1.1c1-.9 2.3-1.4 3.7-1.4ZM8 9a1.6 1.6 0 0 1 1.3.6L8 11 6.7 9.6A1.6 1.6 0 0 1 8 9Z" />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden>
          <rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4" />
          <rect x="2" y="2" width="20" height="9" rx="2.5" fill="currentColor" />
          <path d="M25 4.5v4a2 2 0 0 0 0-4Z" fill="currentColor" opacity=".4" />
        </svg>
      </span>
    </div>
  );
}

/** iPhone frame on a desktop window, plain full-screen on a real phone. Everything inside is positioned against the screen. */
export function Phone({ role, children }: { role: Role; children: React.ReactNode }) {
  return (
    <div className="stage" data-role={role}>
      <div className="device">
        <div className="screen">
          <StatusBar />
          <div className="island" />
          {children}
          <div className="home-ind" />
        </div>
      </div>
      <div className="stage-caption">RideSim · {role === "driver" ? "Driver" : "Customer"}</div>
    </div>
  );
}

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  icon: IconName;
}

export function TabBar<T extends string>({ tabs, value, onChange }: { tabs: TabSpec<T>[]; value: T; onChange: (t: T) => void }) {
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <button key={t.id} aria-pressed={value === t.id} onClick={() => onChange(t.id)} data-testid={`tab-${t.id}`}>
          <Icon name={t.icon} />
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/** Scrollable screen with an iOS large title. */
export function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <h1 className="large-title">{title}</h1>
      {children}
    </div>
  );
}

export function Section({ head, foot, children }: { head?: React.ReactNode; foot?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="section">
      {head && <div className="section-head">{head}</div>}
      <div className="group">{children}</div>
      {foot && <div className="section-foot">{foot}</div>}
    </section>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/* ---------- screens shared by both apps ---------- */

export function LoginForm({ role, onLogin, defaultPhone }: { role: Role; defaultPhone: string; onLogin: (phone: string, name: string) => Promise<void> }) {
  const [phone, setPhone] = useState(defaultPhone);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="login"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await onLogin(phone, name);
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="app-icon"><Icon name={role === "driver" ? "wheel" : "car"} /></div>
      <h2>Masuk sebagai {role === "driver" ? "Driver" : "Customer"}</h2>
      <p className="lead">RideSim — simulator ride-hailing</p>
      <Section foot="POC: tanpa OTP. Nomor baru otomatis terdaftar.">
        <label className="cell">
          <span>Nomor HP</span>
          <input data-testid="login-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" required />
        </label>
        <label className="cell">
          <span>Nama</span>
          <input data-testid="login-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={role === "driver" ? "Pak Budi (opsional)" : "Siti (opsional)"} />
        </label>
      </Section>
      {err && <p className="err" style={{ textAlign: "center" }}>{err}</p>}
      <button className="primary big" data-testid="login-submit" disabled={busy}>
        {busy ? "Masuk…" : "Lanjut"}
      </button>
    </form>
  );
}

const TX_LABEL: Record<string, string> = {
  TOPUP: "Top-up",
  RIDE_PAYMENT: "Bayar ride",
  RIDE_EARNING: "Pendapatan ride",
  COMMISSION: "Komisi platform",
  ADJUSTMENT: "Penyesuaian",
};

export function WalletPanel({ api, refreshKey }: { api: ApiClient; refreshKey?: unknown }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<WalletTx[]>([]);
  const load = async () => {
    const [w, t] = await Promise.all([api.wallet(), api.transactions()]);
    setBalance(w.balance);
    setTxs(t.transactions);
  };
  /** Idempotency-Key per amount, kept until that top-up succeeds: a press after a lost reply never tops up twice */
  const topupKeys = useRef(new Map<number, string>());
  const topup = async (amount: number) => {
    const key = topupKeys.current.get(amount) ?? crypto.randomUUID();
    topupKeys.current.set(amount, key);
    await api.topup(amount, key);
    topupKeys.current.delete(amount);
    await load();
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  return (
    <>
      <div className="balance-card">
        <div>
          <div className="small" style={{ opacity: 0.85 }}>Saldo</div>
          <div data-testid="wallet-balance" className={`amount tnum${balance !== null && balance < 0 ? " neg" : ""}`}>
            {balance === null ? "…" : fmtRp(balance)}
          </div>
        </div>
        <div className="row gap">
          {[50_000, 100_000].map((a) => (
            <button key={a} data-testid={`topup-${a}`} onClick={() => void topup(a)}>
              + {fmtRp(a)}
            </button>
          ))}
        </div>
      </div>
      <Section head="Transaksi">
        <ul className="list">
          {txs.length === 0 && <li className="cell muted">Belum ada transaksi</li>}
          {txs.map((t) => (
            <li key={t.id} className="cell">
              <div className="grow">
                <div>{TX_LABEL[t.type] ?? t.type}</div>
                <div className="sub">{fmtTime(t.createdAt)}</div>
              </div>
              <span className={`tnum ${t.amount < 0 ? "" : "pos"}`}>
                {t.amount > 0 ? "+" : ""}
                {fmtRp(t.amount)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** Dev: wipe all simulator data (both apps log out via socket close / 401), then start fresh. */
export function ResetButton({ api, onDone, className = "cell destructive" }: { api: ApiClient; onDone: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      data-testid="reset-sim"
      title="Hapus semua data simulator (user, ride, wallet)"
      disabled={busy}
      onClick={async () => {
        if (!confirm("Reset simulator? Semua user, ride, dan wallet dihapus.")) return;
        setBusy(true);
        try {
          await api.devReset();
          onDone();
        } catch (e) {
          alert(`Reset gagal: ${(e as Error).message}\nPastikan API jalan dengan DEV_RESET=1 (.dev.vars).`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Mereset…" : "Reset simulator"}
    </button>
  );
}

/** "Akun" tab: who is signed in, dev reset, sign out. */
export function AccountPage({ user, role, api, onLogout, extra }: { user: { name: string; phone: string }; role: Role; api: ApiClient; onLogout: () => void; extra?: React.ReactNode }) {
  return (
    <Page title="Akun">
      <Section>
        <div className="cell" style={{ padding: "14px 16px" }}>
          <div className="avatar lg">{initials(user.name)}</div>
          <div className="grow">
            <div className="title3">{user.name}</div>
            <div className="sub">{role === "driver" ? "Driver" : "Customer"} · {user.phone}</div>
          </div>
        </div>
      </Section>
      {extra}
      <Section head="Developer" foot="Menghapus semua user, ride, dan wallet. Kedua simulator otomatis keluar.">
        <ResetButton api={api} onDone={wipeLocalAndReload} />
      </Section>
      <Section>
        <button className="cell destructive" onClick={onLogout} data-testid="logout">Keluar</button>
      </Section>
    </Page>
  );
}

/**
 * Bottom sheet over the map with two detents (iOS-style): expanded, or minimized to its first row.
 * Drag the grabber / header (snaps by position and flick velocity), or tap the grabber to toggle.
 * Changing `expandKey` (e.g. the ride status) opens it again so the user sees what changed.
 */
export function Sheet({ children, expandKey }: { children: React.ReactNode; expandKey?: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  /** how far down the sheet moves when minimized: everything below the first row of the card */
  const [travel, setTravel] = useState(0);
  const [dragY, setDragY] = useState<number | null>(null);
  const drag = useRef<{ y: number; base: number; t: number; moved: boolean; head: boolean } | null>(null);

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const head = el.querySelector<HTMLElement>("[data-sheet-peek]") ?? el.querySelector<HTMLElement>(".card > :first-child");
    const peek = head ? head.offsetTop + head.offsetHeight + 14 : 72;
    setTravel(Math.max(0, el.offsetHeight - peek));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setCollapsed(false), [expandKey]);
  useEffect(() => {
    if (collapsed && ref.current) ref.current.scrollTop = 0; // the first row must be what stays visible
  }, [collapsed]);

  const offset = dragY ?? (collapsed ? travel : 0);
  const inHandle = (t: EventTarget) => {
    const el = t as HTMLElement;
    if (el.closest(".sheet-grabber")) return true;
    if (el.closest("button, input, select, textarea, a, label")) return false;
    const head = ref.current?.querySelector(".card > :first-child, [data-sheet-peek]");
    return !!head?.contains(el);
  };

  return (
    <div
      ref={ref}
      className={`sheet${collapsed && dragY === null ? " collapsed" : ""}${dragY !== null ? " dragging" : ""}`}
      style={{ transform: `translateY(${offset}px)` }}
      data-testid="sheet"
      data-collapsed={collapsed}
      onPointerDown={(e) => {
        if (!inHandle(e.target)) return;
        drag.current = { y: e.clientY, base: offset, t: performance.now(), moved: false, head: !(e.target as HTMLElement).closest(".sheet-grabber") };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dy) < 4) return;
        d.moved = true;
        const y = d.base + dy;
        // rubber-band past either detent
        setDragY(y < 0 ? y / 4 : y > travel ? travel + (y - travel) / 4 : y);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (!d.moved) {
          // tap: the grabber toggles, the header only opens a minimized sheet
          if (!d.head || collapsed) setCollapsed(!collapsed);
          return;
        }
        const dy = e.clientY - d.y;
        const v = dy / Math.max(1, performance.now() - d.t); // px/ms, + = down
        const y = d.base + dy;
        setCollapsed(v > 0.4 ? true : v < -0.4 ? false : y > travel / 2);
        setDragY(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragY(null);
      }}
    >
      <button
        type="button"
        className="sheet-grabber"
        aria-label={collapsed ? "Perbesar panel" : "Perkecil panel"}
        aria-expanded={!collapsed}
        data-testid="sheet-grabber"
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setCollapsed(!collapsed))}
      />
      {children}
    </div>
  );
}

/** Full-screen address search (iOS search sheet): type-ahead over built-in places + geocoder, or fall back to tapping the map. */
export function PlaceSearch({ title, near, onPick, onMap, onClose }: {
  title: string;
  near?: LatLng;
  onPick: (p: PlaceHit) => void;
  onMap: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>(() => knownPlaces());
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(q.trim().length >= 3);
    const t = setTimeout(() => {
      searchPlaces(q, near, ctl.signal).then((h) => {
        if (ctl.signal.aborted) return;
        setHits(h);
        setLoading(false);
      });
    }, q.trim().length >= 3 ? 300 : 0);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <div className="search-sheet" data-testid="place-search" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="search-title">{title}</div>
      <div className="search-row">
        <label className="search-field">
          <Icon name="search" size={18} />
          <input
            ref={input}
            data-testid="place-search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && hits[0] && onPick(hits[0])}
            placeholder="Cari alamat atau tempat"
            enterKeyHint="search"
            autoComplete="off"
          />
          {q && (
            <button type="button" className="search-clear" aria-label="Hapus" onClick={() => (setQ(""), input.current?.focus())}>
              <Icon name="xmark" size={12} />
            </button>
          )}
        </label>
        <button type="button" className="plain" onClick={onClose}>Batal</button>
      </div>
      <div className="search-results">
        <Section>
          <button className="cell inset" onClick={onMap} data-testid="place-search-map">
            <span className="ic blue"><Icon name="map" /></span>
            <span className="grow">Pilih di peta</span>
            <span className="chev"><Icon name="chevron" size={14} /></span>
          </button>
        </Section>
        <Section head={q.trim() ? (loading ? "Mencari…" : "Hasil") : "Tempat populer"}>
          <ul className="list" data-testid="place-search-results">
            {!loading && hits.length === 0 && <li className="cell muted">Tidak ditemukan. Coba kata lain atau pilih di peta.</li>}
            {hits.map((h, i) => (
              <li key={`${h.lat},${h.lng},${i}`}>
                <button className="cell inset" onClick={() => onPick(h)}>
                  <span className={`ic ${h.source === "preset" ? "orange" : "gray"}`}><Icon name="pin" /></span>
                  <span className="grow">
                    <span style={{ display: "block" }}>{h.label}</span>
                    {h.sub && <span className="sub" style={{ display: "block" }}>{h.sub}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

/** Clear this app's local state (session, position, settings) and reload. */
export function wipeLocalAndReload() {
  try {
    localStorage.clear();
  } catch {
    /* storage blocked */
  }
  location.reload();
}

export function ConnDot({ state }: { state: string }) {
  return <span className={`dot dot-${state}`} title={`socket ${state}`} data-testid="socket-state" data-state={state} />;
}

export function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="toast" data-testid="toast" role="status">
      {text}
    </div>
  );
}

/** Road route between two points (OSRM, straight-line fallback). `null` while loading or when a point is missing. */
export function useRoute(from: LatLng | null | undefined, to: LatLng | null | undefined): Route | null {
  const [route, setRoute] = useState<Route | null>(null);
  const k = from && to ? `${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}` : "";
  useEffect(() => {
    setRoute(null);
    if (!from || !to) return;
    let live = true;
    getRoute(from, to).then((r) => live && setRoute(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  return route;
}
