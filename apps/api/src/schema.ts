// SQLite schema of the zone actors (Durable Objects), as numbered migrations.
//
// Every actor has its own database, which only that actor can reach: there is no "migrate all" to run
// at deploy time (Postgres has its own migrations in ../migrations). Each actor brings its database up
// to date itself, when it starts (`migrate` in the ZoneActor constructor), so an actor that never wakes
// again is never migrated, and costs nothing.
//
// Rules:
//  - Append only. Never edit or reorder a step that has shipped: actors already past it will not run it again.
//  - Step N runs on a database at version N-1, which may hold live rows (rides on their way, timers).
//    Write it so it keeps them: ADD COLUMN with a default, create-copy-rename for anything else.
//  - A change to a table both kinds have (drivers, timers) goes in both lists.
//  - Step 1 is the baseline and uses IF NOT EXISTS: it also adopts actors created before migrations
//    existed (tables present, no version recorded).

/** Tables both kinds of zone actor have: driver rows and the timer queue. */
const SHARED_BASELINE = `
  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT,
    lat REAL, lng REAL, heading REAL, cell TEXT,
    status TEXT NOT NULL, ride_id TEXT, reserved_until INTEGER, offer TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drivers_cell ON drivers (cell);
  CREATE TABLE IF NOT EXISTS timers (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

/**
 * Every driver position of the actor as ONE row (JSON `[id, lat, lng, heading, ts][]`), rewritten at
 * most every SNAPSHOT_MS: only read when the actor restarts. One row per actor, not one per driver,
 * because SQLite bills per row written.
 */
const POS_SNAPSHOT = `
  CREATE TABLE IF NOT EXISTS pos_snapshot (k TEXT PRIMARY KEY, v INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
`;

/** Match actor (`match:<zone>`): free drivers only. */
export const MATCH_MIGRATIONS: readonly string[] = [
  /* 1 */ SHARED_BASELINE,
  /* 2 */ POS_SNAPSHOT,
];

/** Ride actor (`ride:<home>`): rides, drivers on a trip, the trip routes not yet in Postgres. */
export const RIDE_MIGRATIONS: readonly string[] = [
  /* 1 */ `${SHARED_BASELINE}
    CREATE TABLE IF NOT EXISTS rides (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, customer_id TEXT NOT NULL, driver_id TEXT,
      data TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    -- a socket connecting: the driver's active ride / the customer's latest ride, without a table scan
    CREATE INDEX IF NOT EXISTS rides_driver ON rides (driver_id, status);
    CREATE INDEX IF NOT EXISTS rides_customer ON rides (customer_id, updated_at);
    CREATE TABLE IF NOT EXISTS ride_idem (customer_id TEXT NOT NULL, key TEXT NOT NULL, ride_id TEXT NOT NULL,
      PRIMARY KEY (customer_id, key));
    -- ON_TRIP route points not yet in Postgres; seq (AUTOINCREMENT: never reused) is their key there
    CREATE TABLE IF NOT EXISTS track (seq INTEGER PRIMARY KEY AUTOINCREMENT, ride_id TEXT NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS track_ride ON track (ride_id, seq);
  `,
  /* 2 */ POS_SNAPSHOT,
];

/** `meta` row holding the number of migration steps this actor's database has run. */
export const SCHEMA_VERSION_KEY = "schema";

/**
 * Run the steps this database has not run yet, all in one transaction with the new version: a step
 * that fails leaves the database (and its version) as it was, and the actor fails to start rather
 * than run on half a schema. Returns the versions before and after.
 */
export function migrate(storage: DurableObjectStorage, steps: readonly string[]): { from: number; to: number } {
  const sql = storage.sql;
  // bookkeeping, outside the numbered steps (it holds their version)
  sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  const row = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", SCHEMA_VERSION_KEY).toArray()[0];
  const from = row ? Number(row.v) : 0;
  if (from >= steps.length) {
    // newer than this code (a rollback to an older deploy): run on it, as additive steps allow
    if (from > steps.length) console.warn(`actor schema v${from} is newer than this code (v${steps.length})`);
    return { from, to: from };
  }
  storage.transactionSync(() => {
    for (let v = from; v < steps.length; v++) sql.exec(steps[v]!);
    sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", SCHEMA_VERSION_KEY, String(steps.length));
  });
  return { from, to: steps.length };
}
