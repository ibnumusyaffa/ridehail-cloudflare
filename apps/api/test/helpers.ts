import { SELF } from "cloudflare:test";
import type { ServerMsg } from "../src/protocol";

const BASE = "http://api.test";
let seq = 0;
export const uniquePhone = () => `0812${Date.now().toString().slice(-6)}${String(++seq).padStart(3, "0")}`;

export async function api<T = any>(
  path: string,
  opts: { token?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: T }> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as T };
}

export async function login(role: "customer" | "driver", name?: string) {
  const { json } = await api<{ token: string; user: { id: string } }>("/auth/login", {
    body: { phone: uniquePhone(), role, name },
  });
  return { token: json.token, id: json.user.id };
}

type Msg = ServerMsg & Record<string, any>;

/** WebSocket client with an awaitable message inbox. */
export class Client {
  inbox: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  closed = false;

  private constructor(public ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as Msg;
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    });
    ws.addEventListener("close", () => (this.closed = true));
  }

  static async connect(query: Record<string, string | number>): Promise<Client> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const res = await SELF.fetch(`${BASE}/ws?${qs}`, { headers: { Upgrade: "websocket" } });
    if (!res.webSocket) throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
    res.webSocket.accept();
    return new Client(res.webSocket);
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  next(pred: string | ((m: Msg) => boolean), timeoutMs = 8_000): Promise<Msg> {
    const p = typeof pred === "string" ? (m: Msg) => m.t === pred : pred;
    const i = this.inbox.findIndex(p);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = { pred: p, resolve: (m: Msg) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timeout waiting for ${typeof pred === "string" ? pred : "predicate"}; inbox=${JSON.stringify(this.inbox.map((m) => m.t))}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  close() {
    try {
      this.ws.close(1000);
    } catch {}
  }
}

export const status = (s: string) => (m: Msg) => m.t === "ride.status" && m.status === s;

/** Log a driver in, connect at a location and go online. */
export async function onlineDriver(lat: number, lng: number, name?: string) {
  const d = await login("driver", name);
  const ws = await Client.connect({ token: d.token, lat, lng });
  await ws.next("hello");
  ws.send({ t: "online" });
  const st = await ws.next("driver.state");
  if (st.status !== "AVAILABLE") throw new Error(`driver not available: ${JSON.stringify(st)}`);
  return { ...d, ws };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
