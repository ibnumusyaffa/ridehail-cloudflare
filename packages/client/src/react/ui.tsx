import type { LatLng, Role } from "@gojek/core";
import { useEffect, useState } from "react";
import type { ApiClient, WalletTx } from "../api";
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

export function LoginForm({ role, onLogin, defaultPhone }: { role: Role; defaultPhone: string; onLogin: (phone: string, name: string) => Promise<void> }) {
  const [phone, setPhone] = useState(defaultPhone);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card login"
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
      <h2>Masuk sebagai {role === "driver" ? "Driver" : "Customer"}</h2>
      <label>
        Nomor HP
        <input data-testid="login-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" required />
      </label>
      <label>
        Nama (opsional)
        <input data-testid="login-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={role === "driver" ? "Pak Budi" : "Siti"} />
      </label>
      {err && <p className="err">{err}</p>}
      <button className="primary" data-testid="login-submit" disabled={busy}>
        {busy ? "…" : "Masuk"}
      </button>
      <p className="muted">POC: tanpa OTP. Nomor baru otomatis terdaftar.</p>
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
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  return (
    <div className="card">
      <div className="row between">
        <h3>Wallet</h3>
        <strong data-testid="wallet-balance" className={balance !== null && balance < 0 ? "neg" : ""}>
          {balance === null ? "…" : fmtRp(balance)}
        </strong>
      </div>
      <div className="row gap">
        {[50_000, 100_000].map((a) => (
          <button key={a} data-testid={`topup-${a}`} onClick={async () => (await api.topup(a), load())}>
            + {fmtRp(a)}
          </button>
        ))}
      </div>
      <ul className="list">
        {txs.length === 0 && <li className="muted">Belum ada transaksi</li>}
        {txs.map((t) => (
          <li key={t.id} className="row between">
            <span>
              {TX_LABEL[t.type] ?? t.type} <small className="muted">{fmtTime(t.createdAt)}</small>
            </span>
            <span className={t.amount < 0 ? "neg" : "pos"}>
              {t.amount > 0 ? "+" : ""}
              {fmtRp(t.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Dev: wipe all simulator data (both apps log out via socket close / 401), then start fresh. */
export function ResetButton({ api, onDone }: { api: ApiClient; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
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
      🔄 Reset
    </button>
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
    <div className="toast" data-testid="toast">
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
