/**
 * Fake driver fleet: N drivers around Jakarta log in, go online, ping location,
 * accept offers with probability P, drive to pickup → dropoff and complete.
 *
 *   API_URL=http://localhost:8787 pnpm sim -- --n 50 --accept 0.7 --speed 15
 */
import { haversineM, type LatLng } from "@gojek/core";
import { http, rand, sleep, wsUrl } from "./client";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1] ?? "true"), i++;
}
const N = Number(args.get("n") ?? 50);
const ACCEPT = Number(args.get("accept") ?? 0.7);
const SPEED = Number(args.get("speed") ?? 15); // m/s — faster than real life for demos
const CENTER: LatLng = { lat: Number(args.get("lat") ?? -6.2), lng: Number(args.get("lng") ?? 106.8227) };
const RADIUS_DEG = Number(args.get("radius") ?? 0.06); // ~6.5 km
const PHONE_PREFIX = args.get("prefix") ?? "0899";

type Phase = "idle" | "to_pickup" | "waiting" | "to_dropoff";

class SimDriver {
  ws: WebSocket | null = null;
  token = "";
  pos: LatLng;
  heading = 0;
  phase: Phase = "idle";
  rideId: string | null = null;
  pickup: LatLng | null = null;
  dropoff: LatLng | null = null;
  zone: string | null = null;
  backoff = 500;
  lastPing = 0;

  constructor(public i: number) {
    this.pos = { lat: CENTER.lat + rand(-RADIUS_DEG, RADIUS_DEG), lng: CENTER.lng + rand(-RADIUS_DEG, RADIUS_DEG) };
  }

  log(...m: unknown[]) {
    console.log(`[driver ${String(this.i).padStart(3)}]`, ...m);
  }

  async start() {
    const phone = `${PHONE_PREFIX}${String(this.i).padStart(7, "0")}`;
    const { token } = await http<{ token: string }>("/auth/login", { body: { phone, role: "driver", name: `Sim Driver ${this.i}` } });
    this.token = token;
    this.connect();
    setInterval(() => this.tick(1), 1000);
  }

  connect() {
    const ws = new WebSocket(
      wsUrl({ token: this.token, lat: this.pos.lat.toFixed(6), lng: this.pos.lng.toFixed(6), zone: this.zone ?? undefined }),
    );
    this.ws = ws;
    ws.onopen = () => (this.backoff = 500);
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
    ws.onerror = () => {};
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async onMessage(m: any) {
    switch (m.t) {
      case "hello":
        this.zone = null;
        if (m.driverStatus === "ON_RIDE" && m.rideId) this.send({ t: "resume", rideId: m.rideId });
        else {
          this.send({ t: "loc", lat: this.pos.lat, lng: this.pos.lng });
          this.send({ t: "online" });
        }
        break;
      case "zone.moved":
        this.zone = m.rideId ? m.zone : null; // on a ride: follow the ride's zone; otherwise route by location
        break;
      case "offer": {
        await sleep(rand(800, 3000));
        const accept = Math.random() < ACCEPT;
        this.log(accept ? "accept" : "reject", m.rideId, `Rp${m.fare}`);
        this.send({ t: accept ? "offer.accept" : "offer.reject", rideId: m.rideId });
        break;
      }
      case "ride.status":
        this.onRide(m.ride);
        break;
      case "ride.paid":
        this.log("paid", m.paidVia, `Rp${m.fare}`, "balance", m.balance);
        break;
      case "error":
        this.log("error", m.code, m.message);
        if (m.code === "DRIVER_BALANCE_TOO_LOW") {
          await http("/wallet/topup", { token: this.token, body: { amount: 100_000 }, headers: { "Idempotency-Key": crypto.randomUUID() } });
          this.send({ t: "online" });
        }
        break;
    }
  }

  onRide(r: any) {
    if (!r) return;
    if (["COMPLETED", "CANCELLED", "NO_DRIVER"].includes(r.status)) {
      if (r.id === this.rideId) this.log("ride", r.status, r.id);
      if (r.id === this.rideId) {
        this.phase = "idle";
        this.rideId = null;
      }
      return;
    }
    this.rideId = r.id;
    this.pickup = r.pickup;
    this.dropoff = r.dropoff;
    if (r.status === "ACCEPTED") this.phase = "to_pickup";
    if (r.status === "ARRIVED") this.phase = "waiting";
    if (r.status === "ON_TRIP") this.phase = "to_dropoff";
  }

  moveToward(target: LatLng, dt: number): boolean {
    const d = haversineM(this.pos, target);
    const step = SPEED * dt;
    if (d <= step) {
      this.pos = { ...target };
      return true;
    }
    const f = step / d;
    const dLat = target.lat - this.pos.lat;
    const dLng = target.lng - this.pos.lng;
    this.heading = (Math.atan2(dLng, dLat) * 180) / Math.PI;
    this.pos = { lat: this.pos.lat + dLat * f, lng: this.pos.lng + dLng * f };
    return false;
  }

  tick(dt: number) {
    const now = Date.now();
    if (this.phase === "idle") {
      // random wander, ping every 5s
      if (now - this.lastPing < 5000) return;
      this.heading = (this.heading + rand(-40, 40) + 360) % 360;
      const rad = (this.heading * Math.PI) / 180;
      const m = rand(10, 60);
      this.pos = { lat: this.pos.lat + (Math.cos(rad) * m) / 111_000, lng: this.pos.lng + (Math.sin(rad) * m) / 111_000 };
    } else if (this.phase === "to_pickup" && this.pickup && this.moveToward(this.pickup, dt)) {
      this.phase = "waiting";
      this.send({ t: "ride.arrived", rideId: this.rideId });
      setTimeout(() => this.send({ t: "ride.start", rideId: this.rideId }), 3000);
    } else if (this.phase === "to_dropoff" && this.dropoff && this.moveToward(this.dropoff, dt)) {
      this.phase = "idle";
      this.send({ t: "ride.complete", rideId: this.rideId });
    }
    this.lastPing = now;
    this.send({ t: "loc", lat: this.pos.lat, lng: this.pos.lng, heading: Math.round(this.heading) });
  }
}

console.log(`spawning ${N} drivers around ${CENTER.lat},${CENTER.lng} (accept=${ACCEPT}, speed=${SPEED}m/s)`);
for (let i = 1; i <= N; i++) {
  void new SimDriver(i).start().catch((e) => console.error(`driver ${i} failed`, e));
  await sleep(50);
}
