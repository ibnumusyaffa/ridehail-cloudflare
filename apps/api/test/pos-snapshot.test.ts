import { geohashBounds, geohashEncode } from "@gojek/core";
import { describe, expect, it } from "vitest";
import { inZone, onlineDriver } from "./helpers";

// Live positions live in memory; SQLite only gets ONE row per actor (`pos_snapshot`) at most every
// SNAPSHOT_MS, read back when the actor restarts. Driver rows are not rewritten by location pings.

const b = geohashBounds(geohashEncode(-5.14, 119.43, 5)); // Makassar: no other test uses it
const p = { lat: (b.latMin + b.latMax) / 2, lng: (b.lngMin + b.lngMax) / 2 };
const zone = geohashEncode(p.lat, p.lng, 5);

type Snap = { at: number; entries: [string, number, number, number | null, number][] } | null;

async function snapshot(): Promise<Snap> {
  let out: Snap = null;
  await inZone(zone, "match", (inst) => {
    const r = inst.sql.exec("SELECT at, data FROM pos_snapshot WHERE k = 'all'").toArray()[0];
    out = r ? { at: r.at, entries: JSON.parse(r.data) } : null;
  });
  return out;
}

/** Send a ping and wait until the actor has handled it (a `resume` is answered after it). */
async function ping(d: Awaited<ReturnType<typeof onlineDriver>>, lat: number, lng: number) {
  d.ws.send({ t: "loc", lat, lng });
  d.ws.send({ t: "resume" });
  await d.ws.next("driver.state");
}

/** Make the next ping take a snapshot (as if SNAPSHOT_MS had passed). */
const snapshotDue = () =>
  inZone(zone, "match", (inst) => {
    inst.snapshotAt = 0;
  });

describe("position snapshot (one row per actor)", () => {
  it("a ping writes every position into one row, never into the driver rows", async () => {
    const a = await onlineDriver(p.lat, p.lng, "Satu");
    const c = await onlineDriver(p.lat + 0.002, p.lng, "Dua");
    let rowLat = 0;
    await inZone(zone, "match", (inst) => {
      rowLat = inst.sql.exec("SELECT lat FROM drivers WHERE id = ?", a.id).one().lat;
    });

    await snapshotDue();
    await ping(a, p.lat + 0.001, p.lng);

    const snap = await snapshot();
    const byId = new Map(snap!.entries.map((e) => [e[0], e]));
    expect(byId.get(a.id)?.[1]).toBeCloseTo(p.lat + 0.001, 6);
    expect(byId.get(c.id)?.[1]).toBeCloseTo(p.lat + 0.002, 6);
    await inZone(zone, "match", (inst) => {
      // the ping did not touch the driver row
      expect(inst.sql.exec("SELECT lat FROM drivers WHERE id = ?", a.id).one().lat).toBe(rowLat);
      expect(inst.sql.exec("SELECT COUNT(*) AS n FROM pos_snapshot").one().n).toBe(1);
    });

    // within SNAPSHOT_MS: memory moves, the snapshot does not
    await ping(a, p.lat + 0.003, p.lng);
    expect((await snapshot())!.at).toBe(snap!.at);
    a.ws.close();
    c.ws.close();
  });

  it("a restarted actor rebuilds positions from the snapshot, skipping drivers removed since", async () => {
    const a = await onlineDriver(p.lat - 0.003, p.lng, "Pulih");
    const gone = await onlineDriver(p.lat - 0.004, p.lng, "Pergi");
    await snapshotDue();
    await ping(a, p.lat - 0.005, p.lng);

    await inZone(zone, "match", (inst) => {
      // the driver left after the snapshot was taken (its row is gone, the snapshot still has it)
      inst.sql.exec("DELETE FROM drivers WHERE id = ?", gone.id);
      // what eviction does: memory is lost, the constructor runs `loadPositions`
      inst.pos.clear();
      inst.grid.clear();
      inst.loadPositions();
      expect(inst.pos.get(a.id).lat).toBeCloseTo(p.lat - 0.005, 6); // newer than its driver row
      expect(inst.pos.has(gone.id)).toBe(false);
      const cell = inst.pos.get(a.id).cell;
      expect(inst.grid.get(cell).has(a.id)).toBe(true);
    });
    a.ws.close();
    gone.ws.close();
  });
});
