import { env } from "cloudflare:workers";
import { geohashBounds } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { homeOfRide, parseRideHome, parseRideShards, rideHome, shardFor } from "../src/config";
import { api, Client, inZone, login, onlineDriver, sleep, status, withSql } from "./helpers";

// vitest.config.ts shards this zone only: RIDE_SHARDS = "qw8nv=4,*=1"
const ZONE = "qw8nv";
const SHARDS = 4;
const b = geohashBounds(ZONE);
const centre = { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
const off = (dLat: number, dLng = 0) => ({ lat: centre.lat + dLat, lng: centre.lng + dLng });

/** A customer whose rides in ZONE go to `shard` (users are hashed to shards by id). */
async function customerIn(shard: number, balance = 0) {
  for (let i = 0; i < 200; i++) {
    const c = await login("customer", "Sari");
    if (shardFor(c.id, SHARDS) !== shard) continue;
    if (balance) await api("/wallet/topup", { token: c.token, body: { amount: balance }, headers: { "Idempotency-Key": "init" } });
    return c;
  }
  throw new Error(`no customer hashed to shard ${shard}`);
}

const order = (token: string, pickup = centre, key?: string, paymentMethod = "WALLET") =>
  api("/rides", {
    token,
    body: { pickup, dropoff: { lat: pickup.lat + 0.02, lng: pickup.lng + 0.01 }, paymentMethod },
    headers: key ? { "Idempotency-Key": key } : {},
  });

describe("ride shard naming", () => {
  it("RIDE_SHARDS parses a global count or per-zone counts with a default", () => {
    expect(parseRideShards(undefined)).toEqual({ default: 1, byZone: {} });
    expect(parseRideShards("4")).toEqual({ default: 4, byZone: {} });
    expect(parseRideShards("qqguw=8, qqgux=2 ,*=1")).toEqual({ default: 1, byZone: { qqguw: 8, qqgux: 2 } });
    // invalid entries ignored, counts clamped to 1..64
    expect(parseRideShards("bad!=3,qqguw=0,qqgux=999,*=x")).toEqual({ default: 1, byZone: { qqgux: 64 } });
  });

  it("shard 0 keeps the plain zone (old ride ids still route); other homes are canonical only", () => {
    expect(rideHome("qqguw", 0)).toBe("qqguw");
    expect(rideHome("qqguw", 3)).toBe("qqguw.3");
    expect(homeOfRide("qqguw_abc")).toBe("qqguw");
    expect(homeOfRide("qqguw.3_abc")).toBe("qqguw.3");
    expect(parseRideHome("qqguw.3")).toEqual({ zone: "qqguw", shard: 3 });
    // one actor per ride: no aliases of shard 0, no leading zeros, nothing past the bound, no junk
    for (const id of ["qqguw.0_x", "qqguw.03_x", "qqguw.64_x", "qqguw.x_x", "a!b_x", "_x", "qqguw"]) expect(homeOfRide(id), id).toBeNull();
  });

  it("a customer's shard is stable and spreads customers over every shard", () => {
    expect(shardFor("user-1", 1)).toBe(0);
    expect(shardFor("user-1", 4)).toBe(shardFor("user-1", 4));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => shardFor(crypto.randomUUID() + i, 4)));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("sharded zone", () => {
  it("full ride on a shard ≥ 1: offer from the zone's match actor, trip and payment in the shard", async () => {
    const c = await customerIn(2, 100_000);
    const d = await onlineDriver(off(0.002).lat, centre.lng, "Shard");

    const created = await order(c.token, centre, "s-1");
    expect(created.status).toBe(201);
    const rideId: string = created.json.rideId;
    expect(rideId.startsWith(`${ZONE}.2_`)).toBe(true);
    // idempotent retry reaches the same shard
    expect((await order(c.token, centre, "s-1")).json.rideId).toBe(rideId);

    // no rideId given: the gateway finds the active ride and routes to its shard
    const cws = await Client.connect({ token: c.token });
    expect((await cws.next("hello")).rideId).toBe(rideId);

    const offer = await d.ws.next("offer");
    expect(offer.rideId).toBe(rideId);
    d.ws.send({ t: "offer.accept", rideId });
    await cws.next(status("ACCEPTED"));
    // the driver followed `zone.moved` to the shard's actor
    const moved = await d.ws.next("hello");
    expect(moved.zone).toBe(`${ZONE}.2`);

    d.ws.send({ t: "loc", lat: centre.lat + 0.001, lng: centre.lng });
    await cws.next("driver.loc");
    d.ws.send({ t: "ride.arrived", rideId });
    await cws.next(status("ARRIVED"));
    d.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));
    d.ws.send({ t: "ride.complete", rideId });
    await cws.next(status("COMPLETED"));
    expect((await cws.next("ride.paid")).paidVia).toBe("WALLET");

    // the driver went back to the zone's match actor, free
    await d.ws.next((m) => m.t === "driver.state" && m.status === "AVAILABLE");
    await d.ws.next((m) => m.t === "hello" && m.zone === ZONE);

    // the ride lives in shard 2 only; shard 0 never saw it
    let inShard = false;
    let inShard0 = true;
    await inZone(`${ZONE}.2`, "ride", (inst) => (inShard = inst.loadRide(rideId) !== null));
    await inZone(ZONE, "ride", (inst) => (inShard0 = inst.loadRide(rideId) !== null));
    expect(inShard).toBe(true);
    expect(inShard0).toBe(false);

    // the shard registered itself so ops / dev reset can find it
    let keys: string[] = [];
    for (let i = 0; i < 20 && !keys.includes(`${ZONE}.2`); i++) {
      await sleep(50);
      keys = await withSql(env, async (sql) => (await sql`SELECT zone FROM zones`).map((r) => r.zone as string));
    }
    expect(keys).toContain(`${ZONE}.2`);

    cws.close();
    d.ws.close();
  });

  it("rides of different shards are dispatched from the same pool of drivers; cancel routes by id", async () => {
    const c0 = await customerIn(0);
    const c3 = await customerIn(3);
    const d1 = await onlineDriver(off(-0.002).lat, centre.lng, "A");
    const d2 = await onlineDriver(off(-0.003).lat, centre.lng, "B");

    const r0 = (await order(c0.token, off(-0.001), undefined, "CASH")).json.rideId as string;
    const r3 = (await order(c3.token, off(-0.001), undefined, "CASH")).json.rideId as string;
    expect(homeOfRide(r0)).toBe(ZONE);
    expect(homeOfRide(r3)).toBe(`${ZONE}.3`);

    // each driver is offered exactly one of the two rides (the match actor reserves atomically)
    const o1 = await d1.ws.next("offer");
    const o2 = await d2.ws.next("offer");
    expect(new Set([o1.rideId, o2.rideId])).toEqual(new Set([r0, r3]));

    // cancel of the shard-3 ride reaches shard 3 and frees its driver
    const cancelled = await api(`/rides/${r3}/cancel`, { token: c3.token, body: { reason: "ganti rencana" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.ride.status).toBe("CANCELLED");
    const holder = o1.rideId === r3 ? d1 : d2;
    expect((await holder.ws.next("offer.cancelled")).rideId).toBe(r3);

    expect((await api(`/rides/${r0}/cancel`, { token: c0.token, body: { reason: "x" } })).json.ride.status).toBe("CANCELLED");
    d1.ws.close();
    d2.ws.close();
  });

  it("a ride id naming a made-up actor is refused, not routed", async () => {
    const c = await login("customer");
    for (const id of [`${ZONE}.0_x`, `${ZONE}.99_x`, `qw8n.1_x`, `junk_x`]) {
      expect((await api(`/rides/${id}/cancel`, { token: c.token, body: {} })).status, id).toBe(404);
    }
  });
});
