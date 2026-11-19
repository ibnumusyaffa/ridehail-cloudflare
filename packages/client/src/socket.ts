import type { ClientMsg, ServerMsg } from "./protocol";

export type SocketState = "connecting" | "open" | "closed";

export interface RideSocketOptions {
  baseUrl: string;
  token: string;
  /** Extra query params evaluated on every (re)connect, e.g. the driver's current lat/lng. */
  query?: () => Record<string, string | number | undefined>;
  onMessage: (msg: ServerMsg) => void;
  onState?: (s: SocketState) => void;
  /** server closed with 4002: the simulator was reset; the socket stops reconnecting */
  onReset?: () => void;
}

/** Close codes after which every client reconnects at once (deploy / restart): spread them out. */
const STORM_CODES = new Set([1001, 1006, 1012]);

/**
 * WebSocket with auto-reconnect (exponential backoff + jitter), server-directed moves (`reconnect`)
 * and keepalive. Callers send `resume` from their `hello` handler.
 *
 * Where the socket connects is the server's business: it hands out an opaque `route` (in `hello`
 * and `reconnect`) that is sent back on every reconnect. `reconnect` is handled here and never
 * reaches `onMessage`.
 */
export class RideSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;
  /** opaque, from the server's last `hello` / `reconnect` */
  private route: string | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: RideSocketOptions) {
    this.connect();
  }

  private url() {
    const qs = new URLSearchParams({ token: this.opts.token });
    for (const [k, v] of Object.entries(this.opts.query?.() ?? {})) if (v !== undefined) qs.set(k, String(v));
    if (this.route) qs.set("route", this.route);
    return `${this.opts.baseUrl.replace(/^http/, "ws")}/ws?${qs}`;
  }

  private connect() {
    if (this.stopped) return;
    this.opts.onState?.("connecting");
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.opts.onState?.("open");
      this.keepalive = setInterval(() => this.send({ t: "ping" }), 20_000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMsg;
      if (msg.t === "hello") this.route = msg.route;
      if (msg.t === "reconnect") {
        this.route = msg.route;
        this.backoff = 100;
        // the server may leave the old socket open (so a message sent meanwhile still lands): close it here
        ws.close();
        return;
      }
      if (msg.t === "pong") return;
      this.opts.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.keepalive) clearInterval(this.keepalive);
      if (this.ws !== ws) return;
      if (e.code === 4002) {
        this.stopped = true;
        this.opts.onState?.("closed");
        this.opts.onReset?.();
        return;
      }
      this.ws = null;
      this.opts.onState?.("closed");
      if (this.stopped) return;
      // jitter: a deploy drops every socket at once — don't let them all come back in the same instant
      const delay = STORM_CODES.has(e.code) && this.backoff <= 500 ? 500 + Math.random() * 4_500 : this.backoff * (0.5 + Math.random());
      this.timer = setTimeout(() => this.connect(), delay);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    ws.onerror = () => {};
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Force a reconnect (e.g. after login state changes). */
  reconnect() {
    this.ws?.close();
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.keepalive) clearInterval(this.keepalive);
    this.ws?.close();
  }
}
