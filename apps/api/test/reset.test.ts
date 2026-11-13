import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { api, Client, login, onlineDriver } from "./helpers";

it("dev reset wipes D1 + zone actors and kicks live sockets with 4002", async () => {
  const c = await login("customer");
  await api("/wallet/topup", { token: c.token, body: { amount: 10_000 }, headers: { "Idempotency-Key": "r" } });
  const d = await onlineDriver(-6.3, 106.9);
  const closed = new Promise<number>((resolve) => d.ws.ws.addEventListener("close", (e) => resolve(e.code)));
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM zones").first<{ n: number }>())!.n).toBeGreaterThan(0);

  const res = await api("/dev/reset", { body: {} });
  expect(res.status).toBe(200);
  expect(res.json.zones).toBeGreaterThan(0);
  expect(await closed).toBe(4002);
  for (const t of ["users", "wallets", "wallet_transactions", "rides", "vehicles", "zones"])
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n, t).toBe(0);

  // old tokens are dead: REST and WebSocket both refuse
  expect((await api("/me", { token: d.token })).status).toBe(401);
  await expect(Client.connect({ token: d.token, lat: -6.3, lng: 106.9 })).rejects.toThrow(/401/);

  // the zone actor works again after reset
  const d2 = await onlineDriver(-6.3, 106.9);
  d2.ws.close();
});
