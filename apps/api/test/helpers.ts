import { env, runInDurableObject, SELF } from "cloudflare:test";
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

/**
 * WebSocket client with an awaitable message inbox. Like the app's client it follows `reconnect`:
 * closes the socket and connects again with the route given (the inbox carries over; a `hello` follows).
 */
export class Client {
  inbox: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  closed = false;
  /** messages sent while reconnecting after `reconnect` */
  private queued: string[] | null = null;

  private constructor(public ws: WebSocket, private query: Record<string, string | number>) {
    this.attach(ws);
  }

  private attach(ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as Msg;
      if (m.t === "reconnect" && ws === this.ws) void this.follow(m);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    });
    ws.addEventListener("close", () => {
      if (ws === this.ws && this.queued === null) this.closed = true;
    });
  }

  private static async open(query: Record<string, string | number>): Promise<WebSocket> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const res = await SELF.fetch(`${BASE}/ws?${qs}`, { headers: { Upgrade: "websocket" } });
    if (!res.webSocket) throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
    res.webSocket.accept();
    return res.webSocket;
  }

  static async connect(query: Record<string, string | number>): Promise<Client> {
    return new Client(await Client.open(query), query);
  }

  private async follow(m: Msg) {
    const { route: _r, ...rest } = this.query;
    this.query = m.route ? { ...rest, route: m.route } : rest;
    this.queued = [];
    const old = this.ws;
    try {
      old.close(1000);
    } catch {}
    try {
      this.ws = await Client.open(this.query);
      this.attach(this.ws);
      for (const q of this.queued) this.ws.send(q);
    } catch {
      this.closed = true;
    } finally {
      this.queued = null;
    }
  }

  send(msg: object) {
    if (this.queued) this.queued.push(JSON.stringify(msg));
    else this.ws.send(JSON.stringify(msg));
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

/**
 * Run `fn` on a zone's actor instance: "ride" (rides, dispatch, transitions) or "match" (free drivers,
 * reservations); "both" runs it on each. Loosely typed: the actors' RPC types exceed tsc's depth limit.
 */
export async function inZone(zone: string, kind: "ride" | "match" | "both", fn: (inst: any) => void) {
  const run = runInDurableObject as unknown as (stub: unknown, fn: (inst: any) => void) => Promise<void>;
  const e = env as unknown as { MATCH: DurableObjectNamespace; RIDE: DurableObjectNamespace };
  for (const k of kind === "both" ? (["match", "ride"] as const) : [kind]) {
    const ns = k === "match" ? e.MATCH : e.RIDE;
    await run(ns.get(ns.idFromName(`${k}:${zone}`)), fn);
  }
}

/** "down": every Postgres call of the zone's actors fails; "lost-reply": it commits, then the caller sees an error. */
export const postgresOutage = (zone: string, mode: "off" | "down" | "lost-reply") =>
  inZone(zone, "both", (inst) => {
    delete inst.pg; // back to the prototype's real implementation
    if (mode === "off") return;
    const real = inst.pg.bind(inst);
    inst.pg =
      mode === "down"
        ? () => Promise.reject(new Error("simulated Postgres outage"))
        : async (fn: unknown) => {
            await real(fn);
            throw new Error("simulated lost reply");
          };
  });

/** Run `fn` against the test database (same Hyperdrive binding the app uses). */
export { withDb as withSql } from "../src/pg";
