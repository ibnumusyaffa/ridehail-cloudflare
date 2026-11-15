import { ACTIVE_STATUSES } from "@gojek/core";
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
 * WebSocket with auto-reconnect (exponential backoff + jitter), zone hand-over (`zone.moved`)
 * and keepalive. Callers send `resume` from their `hello` handler.
 *
 * After the first `hello` the socket tracks the user's active ride itself and reconnects with
 * `known=1` (plus `rideId` when on a ride), so the server never has to look it up in the database.
 */
export class RideSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;
  private zone: string | null = null;
  private rideId: string | null = null;
  /** true once a hello arrived: from then on this socket knows whether it has an active ride */
  private known = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: RideSocketOptions) {
    this.connect();
  }

  private url() {
    const qs = new URLSearchParams({ token: this.opts.token });
    for (const [k, v] of Object.entries(this.opts.query?.() ?? {})) if (v !== undefined) qs.set(k, String(v));
    // on a ride → its ride actor (by rideId); otherwise the match actor (zone told by zone.moved, else location)
    if (this.rideId && !qs.has("rideId")) qs.set("rideId", this.rideId);
    else if (this.zone) qs.set("zone", this.zone);
    if (this.known) qs.set("known", "1");
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
      if (msg.t === "hello") {
        this.zone = null;
        this.known = true;
        // a driver lives in the ride's zone only while ON_RIDE; a customer always follows its ride
        if (msg.role === "driver") this.rideId = msg.driverStatus === "ON_RIDE" ? (msg.rideId ?? null) : null;
        else if (msg.rideId) this.rideId = msg.rideId;
      }
      if (msg.t === "driver.state") this.rideId = msg.status === "ON_RIDE" ? msg.rideId : null;
      if (msg.t === "ride.status") {
        if (ACTIVE_STATUSES.includes(msg.status)) this.rideId = msg.rideId;
        else if (this.rideId === msg.rideId) this.rideId = null;
      }
      if (msg.t === "zone.moved") {
        // on a ride: reconnect to the ride's actor; otherwise to the match actor of `zone`
        this.zone = msg.zone || null;
        this.rideId = msg.rideId ?? null;
        this.backoff = 100;
        // the server may leave the old socket open (so a message sent meanwhile still lands): close it here
        ws.close();
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
