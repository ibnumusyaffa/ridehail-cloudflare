import { env } from "cloudflare:test";
import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { api, Client, inZone, login, onlineDriver, postgresOutage, sleep, status, withSql } from "./helpers";

// The driver's route during ON_TRIP is kept: each accepted location ping is buffered in the zone
// actor's SQLite and sent to Postgres (`ride_track`) every TRACK_FLUSH_MS, plus once more when the
// ride ends. The interval is shortened per zone actor (a minute by default).

let area = 0;
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-6.2 - area * 0.1, 105.6 + area * 0.07, 5));
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const zoneOf = (p: { lat: number; lng: number }) => geohashEncode(p.lat, p.lng, 5);

async function flushEvery(zone: string, ms: number) {
  await inZone(zone, "ride", (inst) => {
    inst.cfg.trackFlushMs = ms;
  });
}

/** "down": every Postgres call of the zone's actors fails; "off": back to normal. */
const postgres = (zone: string, mode: "down" | "off") => postgresOutage(zone, mode);

const pgTrack = (rideId: string) =>
  withSql(env as unknown as Env, async (sql) =>
    (await sql`SELECT lat, lng, at FROM ride_track WHERE ride_id = ${rideId} ORDER BY seq`).map((r) => ({
      lat: r.lat as number,
      lng: r.lng as number,
      at: r.at as number,
    })),
  );

/** A CASH ride accepted by a driver near `p`; the customer is connected to watch it. */
async function accepted(flushMs: number) {
  const p = spot();
  const c = await login("customer", "Rina");
  const drv = await onlineDriver(off(p, 0.001).lat, p.lng, "Joko");
  await flushEvery(zoneOf(p), flushMs);
  const created = await api("/rides", { token: c.token, body: { pickup: p, dropoff: off(p, 0.03, 0.02), paymentMethod: "CASH" } });
  expect(created.status).toBe(201);
  const rideId: string = created.json.rideId;
  const cws = await Client.connect({ token: c.token, rideId });
  await cws.next("hello");
  await drv.ws.next("offer");
  drv.ws.send({ t: "offer.accept", rideId });
  await cws.next(status("ACCEPTED"));
  return { p, c, drv, rideId, cws };
}

/** Send pings `step` apart (each > LOC_MIN_MOVE_M) and wait until the customer saw each one. */
async function drive(drv: { ws: Client }, cws: Client, from: { lat: number; lng: number }, n: number, step = 0.001) {
  const sent: { lat: number; lng: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const pt = off(from, step * i);
    drv.ws.send({ t: "loc", ...pt });
    await cws.next("driver.loc");
    sent.push(pt);
  }
  return sent;
}

describe("ON_TRIP route is stored in Postgres", () => {
  it("pings of the trip arrive in order when the ride completes; pings before the trip are not kept", async () => {
    const { p, drv, rideId, cws } = await accepted(60_000);
    await drive(drv, cws, p, 2); // on the way to pickup: not part of the trip
    drv.ws.send({ t: "ride.arrived", rideId });
    drv.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));

    const trip = await drive(drv, cws, off(p, 0.01), 4);
    drv.ws.send({ t: "ride.complete", rideId });
    await cws.next(status("COMPLETED"));
    await sleep(300);

    const track = await pgTrack(rideId);
    expect(track.map(({ lat, lng }) => ({ lat, lng }))).toEqual(trip);
    for (let i = 1; i < track.length; i++) expect(track[i]!.at).toBeGreaterThanOrEqual(track[i - 1]!.at);
    cws.close();
    drv.ws.close();
  });

  it("is sent periodically while the trip is still going", async () => {
    const { p, drv, rideId, cws } = await accepted(300);
    drv.ws.send({ t: "ride.arrived", rideId });
    drv.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));

    const first = await drive(drv, cws, p, 3);
    await sleep(800);
    expect((await pgTrack(rideId)).length).toBe(3);

    const more = await drive(drv, cws, off(p, 0.01), 2);
    await sleep(800);
    expect((await pgTrack(rideId)).map(({ lat, lng }) => ({ lat, lng }))).toEqual([...first, ...more]);
    expect((await api(`/rides/${rideId}`, { token: drv.token })).json.ride.status).toBe("ON_TRIP");
    cws.close();
    drv.ws.close();
  });

  it("Postgres down: points wait in the zone actor and arrive once, after it is back", async () => {
    const { p, drv, rideId, cws } = await accepted(300);
    drv.ws.send({ t: "ride.arrived", rideId });
    drv.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));

    const before = await drive(drv, cws, p, 2);
    await sleep(800);
    await postgres(zoneOf(p), "down");
    const during = await drive(drv, cws, off(p, 0.01), 3);
    await sleep(800);
    expect((await pgTrack(rideId)).length).toBe(2);

    await postgres(zoneOf(p), "off");
    await sleep(800);
    expect((await pgTrack(rideId)).map(({ lat, lng }) => ({ lat, lng }))).toEqual([...before, ...during]);
    cws.close();
    drv.ws.close();
  });
});
