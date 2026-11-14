import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { api, Client, login, onlineDriver, sleep, status } from "./helpers";

// Each test uses its own area so drivers from other tests don't interfere.
let area = 0;
/** Centre of a distinct zone, so nearby test drivers stay in the same zone. */
function spot() {
  area++;
  const b = geohashBounds(geohashEncode(-6.1 - area * 0.1, 106.6 + area * 0.07, 5));
  return { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
}
const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });

async function customer(balance = 0) {
  const c = await login("customer", "Budi");
  if (balance) await api("/wallet/topup", { token: c.token, body: { amount: balance }, headers: { "Idempotency-Key": "init" } });
  return c;
}

async function requestRide(token: string, pickup: { lat: number; lng: number }, paymentMethod = "CASH", key?: string) {
  return api("/rides", {
    token,
    body: { pickup: { ...pickup, label: "Jemput" }, dropoff: { ...off(pickup, 0.03, 0.02), label: "Tujuan" }, paymentMethod },
    headers: key ? { "Idempotency-Key": key } : {},
  });
}

describe("ride flow", () => {
  it("estimate → order → reject → next driver accepts → arrive → start → complete (wallet) → paid", async () => {
    const p = spot();
    const c = await customer(100_000);
    const near = await onlineDriver(off(p, 0.001).lat, p.lng, "Near");
    const far = await onlineDriver(off(p, 0.004).lat, p.lng, "Far");

    const est = await api("/rides/estimate", { token: c.token, body: { pickup: p, dropoff: off(p, 0.03, 0.02) } });
    expect(est.status).toBe(200);

    const created = await requestRide(c.token, p, "WALLET", "order-1");
    expect(created.status).toBe(201);
    const rideId: string = created.json.rideId;
    // idempotent order
    expect((await requestRide(c.token, p, "WALLET", "order-1")).json.rideId).toBe(rideId);
    // only one active ride
    expect((await requestRide(c.token, p, "WALLET")).status).toBe(409);

    const cws = await Client.connect({ token: c.token, rideId });
    await cws.next("hello");

    const o1 = await near.ws.next("offer");
    expect(o1.rideId).toBe(rideId);
    expect(o1.fare).toBe(est.json.fare);
    near.ws.send({ t: "offer.reject", rideId });

    const o2 = await far.ws.next("offer");
    expect(o2.rideId).toBe(rideId);
    far.ws.send({ t: "offer.accept", rideId });

    const accepted = await cws.next(status("ACCEPTED"));
    expect(accepted.driver.name).toBe("Far");
    expect(accepted.driver.vehicle.plate).toBeTruthy();
    await far.ws.next(status("ACCEPTED"));

    far.ws.send({ t: "loc", lat: p.lat + 0.002, lng: p.lng });
    const loc = await cws.next("driver.loc");
    expect(loc.lat).toBeCloseTo(p.lat + 0.002);

    // invalid transition is rejected
    far.ws.send({ t: "ride.start", rideId });
    expect((await far.ws.next("error")).code).toBe("INVALID_TRANSITION");

    far.ws.send({ t: "ride.arrived", rideId });
    await cws.next(status("ARRIVED"));
    far.ws.send({ t: "ride.start", rideId });
    await cws.next(status("ON_TRIP"));
    far.ws.send({ t: "ride.complete", rideId });
    far.ws.send({ t: "ride.complete", rideId }); // duplicate: idempotent
    await cws.next(status("COMPLETED"));

    const paidC = await cws.next("ride.paid");
    const paidD = await far.ws.next("ride.paid");
    const fare = est.json.fare as number;
    expect(paidC).toMatchObject({ paidVia: "WALLET", fare, balance: 100_000 - fare });
    expect(paidD).toMatchObject({ paidVia: "WALLET", fare, balance: fare - Math.round(fare * 0.2) });
    expect((await far.ws.next((m) => m.t === "driver.state" && m.status === "AVAILABLE")).rideId).toBeNull();
    await sleep(100);
    expect(far.ws.inbox.filter((m) => m.t === "ride.paid")).toHaveLength(0);

    const detail = await api(`/rides/${rideId}`, { token: c.token });
    expect(detail.json.ride).toMatchObject({ status: "COMPLETED", paidVia: "WALLET", fareFinal: fare });
    expect((await api(`/rides/${rideId}/rating`, { token: c.token, body: { stars: 5 } })).status).toBe(200);
    expect((await api(`/rides/${rideId}/rating`, { token: c.token, body: { stars: 4 } })).status).toBe(409);
    expect((await api("/rides?mine=1", { token: c.token })).json.rides[0].rating).toBe(5);
    const hist = await api("/rides?mine=1", { token: far.token });
    expect(hist.json.today.count).toBe(1);

    // stranger cannot read the ride
    expect((await api(`/rides/${rideId}`, { token: near.token })).status).toBe(403);
    for (const w of [cws, near.ws, far.ws]) w.close();
  });

  it("offer timeout moves to the next candidate; timed-out driver gets offer.cancelled", async () => {
    const p = spot();
    const c = await customer();
    const slow = await onlineDriver(off(p, 0.001).lat, p.lng);
    const next = await onlineDriver(off(p, 0.003).lat, p.lng);
    const { json } = await requestRide(c.token, p);
    await slow.ws.next("offer");
    const cancelled = await slow.ws.next("offer.cancelled", 5_000);
    expect(cancelled).toMatchObject({ rideId: json.rideId, reason: "TIMEOUT" });
    // late accept is refused
    slow.ws.send({ t: "offer.accept", rideId: json.rideId });
    expect((await slow.ws.next("error")).code).toBe("OFFER_EXPIRED");
    const o = await next.ws.next("offer", 5_000);
    expect(o.rideId).toBe(json.rideId);
    next.ws.send({ t: "offer.accept", rideId: json.rideId });
    await next.ws.next(status("ACCEPTED"));
    slow.ws.close();
    next.ws.close();
  });

  it("two rides competing for one driver: only one gets it", async () => {
    const p = spot();
    const d = await onlineDriver(p.lat, p.lng);
    const [c1, c2] = await Promise.all([customer(), customer()]);
    const [r1, r2] = await Promise.all([requestRide(c1.token, off(p, 0.001)), requestRide(c2.token, off(p, -0.001))]);
    const offer = await d.ws.next("offer");
    await sleep(500);
    expect(d.ws.inbox.filter((m) => m.t === "offer")).toHaveLength(0); // never double-offered
    d.ws.send({ t: "offer.accept", rideId: offer.rideId });
    await d.ws.next(status("ACCEPTED"));
    // the other ride ends with NO_DRIVER (researched once, nobody free)
    const loser = offer.rideId === r1.json.rideId ? r2 : r1;
    const loserToken = loser === r1 ? c1.token : c2.token;
    const lws = await Client.connect({ token: loserToken, rideId: loser.json.rideId });
    await lws.next("hello");
    lws.send({ t: "resume", rideId: loser.json.rideId });
    await lws.next(status("NO_DRIVER"), 5_000);
    d.ws.close();
    lws.close();
  });

  it("no driver nearby → NO_DRIVER", async () => {
    const c = await customer();
    const { json } = await requestRide(c.token, { lat: -7.9, lng: 112.6 });
    const ws = await Client.connect({ token: c.token, rideId: json.rideId });
    await ws.next("hello");
    ws.send({ t: "resume" , rideId: json.rideId });
    await ws.next(status("NO_DRIVER"), 5_000);
    ws.close();
  });

  it("customer cancel while offering releases the driver", async () => {
    const p = spot();
    const c = await customer();
    const d = await onlineDriver(p.lat, p.lng);
    const { json } = await requestRide(c.token, p);
    await d.ws.next("offer");
    const res = await api(`/rides/${json.rideId}/cancel`, { token: c.token, body: { reason: "berubah pikiran" } });
    expect(res.json.ride.status).toBe("CANCELLED");
    expect((await d.ws.next("offer.cancelled")).reason).toBe("CANCELLED");
    // driver can be matched again
    const c2 = await customer();
    const r2 = await requestRide(c2.token, p);
    expect((await d.ws.next("offer")).rideId).toBe(r2.json.rideId);
    d.ws.close();
  });

  it("wallet order rejected when balance < fare", async () => {
    const c = await customer(1_000);
    const res = await requestRide(c.token, spot(), "WALLET");
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("driver after accept can cancel with a reason before pickup", async () => {
    const p = spot();
    const c = await customer();
    const d = await onlineDriver(p.lat, p.lng);
    const { json } = await requestRide(c.token, p);
    await d.ws.next("offer");
    d.ws.send({ t: "offer.accept", rideId: json.rideId });
    await d.ws.next(status("ACCEPTED"));
    expect((await api(`/rides/${json.rideId}/cancel`, { token: d.token, body: {} })).status).toBe(400);
    const res = await api(`/rides/${json.rideId}/cancel`, { token: d.token, body: { reason: "ban bocor" } });
    expect(res.json.ride).toMatchObject({ status: "CANCELLED", cancelledBy: "driver" });
    expect((await d.ws.next((m) => m.t === "driver.state")).status).toBe("AVAILABLE");
    d.ws.close();
  });

  it("cross-zone: driver in the neighbouring zone is offered, hands over to the ride zone, completes", async () => {
    // pickup just inside the north edge of its zone, driver just across it
    const base = spot();
    const zone = geohashEncode(base.lat, base.lng, 5);
    const b = geohashBounds(zone);
    const pickup = { lat: b.latMax - 0.0005, lng: (b.lngMin + b.lngMax) / 2 };
    const driverAt = { lat: b.latMax + 0.0005, lng: pickup.lng };
    expect(geohashEncode(driverAt.lat, driverAt.lng, 5)).not.toBe(zone);

    const c = await customer();
    const d = await onlineDriver(driverAt.lat, driverAt.lng);
    const { json } = await requestRide(c.token, pickup);
    expect(json.rideId.startsWith(`${zone}_`)).toBe(true);
    const o = await d.ws.next("offer");
    d.ws.send({ t: "offer.accept", rideId: o.rideId });
    await d.ws.next(status("ACCEPTED"));
    const moved = await d.ws.next("zone.moved");
    expect(moved.zone).toBe(zone);

    // reconnect into the ride's zone and finish the trip there
    const d2 = await Client.connect({ token: d.token, zone: moved.zone, lat: driverAt.lat, lng: driverAt.lng });
    const hello = await d2.next("hello");
    expect(hello).toMatchObject({ zone, driverStatus: "ON_RIDE", rideId: o.rideId });
    const cws = await Client.connect({ token: c.token, rideId: o.rideId });
    await cws.next("hello");
    d2.send({ t: "loc", lat: pickup.lat, lng: pickup.lng });
    await cws.next("driver.loc");
    for (const t of ["ride.arrived", "ride.start", "ride.complete"]) d2.send({ t, rideId: o.rideId });
    await cws.next(status("COMPLETED"));
    expect((await cws.next("ride.paid")).paidVia).toBe("CASH");
    d2.close();
    cws.close();
  });

  it("one active ride per customer holds across zones (two parallel orders, different zones)", async () => {
    const [a, b] = [spot(), spot()];
    expect(geohashEncode(a.lat, a.lng, 5)).not.toBe(geohashEncode(b.lat, b.lng, 5));
    const c = await customer();
    const res = await Promise.all([requestRide(c.token, a), requestRide(c.token, b)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.json.error.code).toBe("ACTIVE_RIDE_EXISTS");
  });

  it("wallet order holds the fare; cancelling releases it", async () => {
    const p = spot();
    const c = await customer(50_000);
    const { json, status: st } = await requestRide(c.token, p, "WALLET");
    expect(st).toBe(201);
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 50_000, held: json.ride.fare });
    await api(`/rides/${json.rideId}/cancel`, { token: c.token, body: { reason: "batal" } });
    expect((await api("/wallet", { token: c.token })).json).toEqual({ balance: 50_000, held: 0 });
  });

  it("zone hand-over waits out GPS jitter on the border (hysteresis)", async () => {
    const base = spot();
    const b = geohashBounds(geohashEncode(base.lat, base.lng, 5));
    const lng = (b.lngMin + b.lngMax) / 2;
    const inside = { lat: b.latMax - 0.002, lng };
    const justAcross = { lat: b.latMax + 0.0002, lng }; // ~22 m into the northern zone
    const d = await onlineDriver(inside.lat, inside.lng);
    d.ws.send({ t: "loc", ...justAcross });
    d.ws.send({ t: "loc", ...inside }); // jitter back: counter resets
    d.ws.send({ t: "loc", ...justAcross });
    d.ws.send({ t: "loc", ...justAcross });
    await sleep(300);
    expect(d.ws.inbox.some((m) => m.t === "zone.moved")).toBe(false);
    d.ws.send({ t: "loc", ...justAcross }); // 3rd consecutive ping outside
    expect((await d.ws.next("zone.moved")).zone).toBe(geohashEncode(justAcross.lat, justAcross.lng, 5));
    d.ws.close();
  });

  it("known=1 reconnects skip the active-ride lookup", async () => {
    const c = await customer();
    const { json } = await requestRide(c.token, spot());
    const ws = await Client.connect({ token: c.token }); // cold start: database finds the ride
    expect((await ws.next("hello")).rideId).toBe(json.rideId);
    ws.close();
    await expect(Client.connect({ token: c.token, known: 1 })).rejects.toThrow(/400/);
  });

  it("rejects bad auth and bad input", async () => {
    expect((await api("/me")).status).toBe(401);
    const c = await customer();
    const d = await login("driver");
    expect((await api("/rides", { token: d.token, body: {} })).status).toBe(403);
    expect((await api("/rides", { token: c.token, body: { pickup: { lat: 999, lng: 0 }, dropoff: {} } })).status).toBe(400);
    expect((await api("/auth/login", { body: { phone: "0812", role: "admin" } })).status).toBe(400);
    const me = await api("/me", { token: d.token });
    expect(me.json.vehicle.plate).toBeTruthy();
  });
});
