/**
 * One customer orders a ride and prints every event until it finishes.
 * Run the simulator first:  pnpm sim  (in another terminal)
 *
 *   API_URL=http://localhost:8787 pnpm demo -- --pay WALLET
 */
import { http, rand, wsUrl } from "./client";

const pay = process.argv.includes("--pay") ? process.argv[process.argv.indexOf("--pay") + 1] : "WALLET";
const phone = `0812${Math.floor(rand(1e6, 1e7))}`;
const { token, user } = await http("/auth/login", { body: { phone, role: "customer", name: "Demo Customer" } });
console.log("customer", user.id);
await http("/wallet/topup", { token, body: { amount: 200_000 }, headers: { "Idempotency-Key": crypto.randomUUID() } });

const pickup = { lat: -6.2 + rand(-0.02, 0.02), lng: 106.8227 + rand(-0.02, 0.02), label: "Pickup" };
const dropoff = { lat: pickup.lat + rand(-0.03, 0.03), lng: pickup.lng + rand(-0.03, 0.03), label: "Dropoff" };
const est = await http("/rides/estimate", { token, body: { pickup, dropoff } });
console.log(`estimate: ${(est.distanceM / 1000).toFixed(1)} km, Rp${est.fare}`);

const { rideId } = await http("/rides", { token, body: { pickup, dropoff, paymentMethod: pay }, headers: { "Idempotency-Key": crypto.randomUUID() } });
console.log("ride", rideId);

let locs = 0;
const ws = new WebSocket(wsUrl({ token, rideId }));
ws.onopen = () => ws.send(JSON.stringify({ t: "resume", rideId }));
ws.onmessage = async (e) => {
  const m = JSON.parse(String(e.data));
  if (m.t === "driver.loc") {
    if (++locs % 10 === 1) console.log(`  driver @ ${m.lat.toFixed(5)},${m.lng.toFixed(5)}`);
    return;
  }
  if (m.t === "ride.status") console.log(`status ${m.status}`, m.driver ? `— ${m.driver.name} ${m.driver.vehicle?.plate ?? ""}` : "");
  else console.log(m.t, JSON.stringify(m));
  if (m.t === "ride.paid" || (m.t === "ride.status" && ["CANCELLED", "NO_DRIVER"].includes(m.status))) {
    if (m.t === "ride.paid") await http(`/rides/${rideId}/rating`, { token, body: { stars: 5 } });
    const w = await http("/wallet", { token });
    console.log("wallet balance", w.balance);
    ws.close();
    process.exit(0);
  }
};
