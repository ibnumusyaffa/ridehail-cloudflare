import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MATCH_MIGRATIONS, migrate, RIDE_MIGRATIONS, SCHEMA_VERSION_KEY } from "../src/schema";

// Each test runs on its own actor (names no other test uses), so changing its schema touches nothing else.
let n = 0;
async function inActor(kind: "match" | "ride", fn: (storage: DurableObjectStorage) => void) {
  const run = runInDurableObject as unknown as (stub: unknown, fn: (inst: unknown, state: DurableObjectState) => void) => Promise<void>;
  const ns = (env as unknown as Record<"MATCH" | "RIDE", DurableObjectNamespace>)[kind === "match" ? "MATCH" : "RIDE"];
  await run(ns.get(ns.idFromName(`${kind}:schema-test-${++n}`)), (_inst, state) => fn(state.storage));
}

const version = (s: DurableObjectStorage) =>
  Number(s.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", SCHEMA_VERSION_KEY).one().v);
const tables = (s: DurableObjectStorage) =>
  s.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => r.name);
const columns = (s: DurableObjectStorage, table: string) =>
  s.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().map((r) => r.name);

const addRide = (s: DurableObjectStorage, id: string) =>
  s.sql.exec("INSERT INTO rides (id, status, customer_id, data, updated_at) VALUES (?, 'ON_TRIP', 'c1', '{}', 1)", id);

describe("zone actor SQLite migrations", () => {
  it("a new actor starts at the latest version with every table of its kind", async () => {
    await inActor("ride", (s) => {
      expect(version(s)).toBe(RIDE_MIGRATIONS.length);
      expect(tables(s)).toEqual(expect.arrayContaining(["drivers", "meta", "ride_idem", "rides", "timers", "track"]));
    });
    await inActor("match", (s) => {
      expect(version(s)).toBe(MATCH_MIGRATIONS.length);
      expect(tables(s)).toEqual(expect.arrayContaining(["drivers", "meta", "timers"]));
      expect(tables(s)).not.toContain("rides");
    });
  });

  it("adopts an actor created before migrations existed (tables present, no version), keeping its rows", async () => {
    await inActor("ride", (s) => {
      addRide(s, "r1");
      s.sql.exec("DELETE FROM meta WHERE k = ?", SCHEMA_VERSION_KEY);
      expect(migrate(s, RIDE_MIGRATIONS)).toEqual({ from: 0, to: RIDE_MIGRATIONS.length });
      expect(s.sql.exec("SELECT id FROM rides").toArray()).toEqual([{ id: "r1" }]);
    });
  });

  it("runs only the new steps, once, and keeps live rows", async () => {
    await inActor("ride", (s) => {
      addRide(s, "r1");
      const steps = [...RIDE_MIGRATIONS, "ALTER TABLE rides ADD COLUMN pickup_cell TEXT DEFAULT 'none'"];
      const v = RIDE_MIGRATIONS.length;
      expect(migrate(s, steps)).toEqual({ from: v, to: v + 1 });
      expect(s.sql.exec("SELECT id, pickup_cell FROM rides").toArray()).toEqual([{ id: "r1", pickup_cell: "none" }]);
      // the next start: nothing left to run (ADD COLUMN again would throw)
      expect(migrate(s, steps)).toEqual({ from: v + 1, to: v + 1 });
      expect(version(s)).toBe(v + 1);
    });
  });

  it("a failing step leaves the schema and the version as they were", async () => {
    await inActor("ride", (s) => {
      const v = RIDE_MIGRATIONS.length;
      const steps = [...RIDE_MIGRATIONS, "ALTER TABLE rides ADD COLUMN a TEXT; ALTER TABLE no_such_table ADD COLUMN b TEXT"];
      expect(() => migrate(s, steps)).toThrow();
      expect(version(s)).toBe(v);
      expect(columns(s, "rides")).not.toContain("a");
    });
  });

  it("a database newer than the code (rollback to an older deploy) is left alone", async () => {
    await inActor("match", (s) => {
      const v = MATCH_MIGRATIONS.length;
      s.sql.exec("UPDATE meta SET v = ? WHERE k = ?", String(v + 2), SCHEMA_VERSION_KEY);
      expect(migrate(s, MATCH_MIGRATIONS)).toEqual({ from: v + 2, to: v + 2 });
      expect(version(s)).toBe(v + 2);
    });
  });
});
