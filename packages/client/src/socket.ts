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

/**
 * WebSocket with auto-reconnect (exponential backoff), zone hand-over (`zone.moved`)
 * and keepalive. Callers send `resume` from their `hello` handler.
 */
export class RideSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;
  private zone: string | null = null;
  private rideId: string | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: RideSocketOptions) {
    this.connect();
  }

  private url() {
    const qs = new URLSearchParams({ token: this.opts.token });
    for (const [k, v] of Object.entries(this.opts.query?.() ?? {})) if (v !== undefined) qs.set(k, String(v));
    if (this.zone) qs.set("zone", this.zone);
    if (this.rideId && !qs.has("rideId") && !this.zone) qs.set("rideId", this.rideId);
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
      if (msg.t === "hello") this.zone = null;
      if (msg.t === "zone.moved") {
        // on a ride: follow the ride's zone; otherwise reconnect routed by location
        this.zone = msg.rideId ? msg.zone : null;
        if (msg.rideId) this.rideId = msg.rideId;
        this.backoff = 100;
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
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    ws.onerror = () => {};
  }

  /** Route the next reconnect to this ride (customer). */
  setRide(rideId: string | null) {
    this.rideId = rideId;
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
