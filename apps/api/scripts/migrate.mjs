#!/usr/bin/env node
// Apply ./migrations/*.sql to Postgres in order, once each (tracked in schema_migrations).
//   node scripts/migrate.mjs [--reset] [postgres://url]
// URL defaults to $DATABASE_URL, then the local docker-compose database.
// --reset drops every table first (dev/test/e2e databases only).
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const url = args.find((a) => !a.startsWith("--")) ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/gojek";
const dir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (reset) await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const text = await readFile(join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
    });
    console.log(`applied ${f}`);
  }
  console.log(`migrations up to date (${new URL(url).pathname.slice(1)})`);
} finally {
  await sql.end();
}
