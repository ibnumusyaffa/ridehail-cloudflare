import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { begin, DbTimeoutError, PG_STATEMENT_TIMEOUT_MS, withDb } from "../src/pg";

const e = env as unknown as Env;

describe("Postgres time limits", () => {
  it("withDb rejects with DbTimeoutError when the work outlives its deadline", async () => {
    const started = Date.now();
    await expect(withDb(e, (sql) => sql`SELECT pg_sleep(2)`, 200)).rejects.toBeInstanceOf(DbTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("withDb still returns results within the deadline", async () => {
    const [r] = await withDb(e, (sql) => sql`SELECT 1 AS one`);
    expect(r!.one).toBe(1);
  });

  it("transactions run with the server-side statement_timeout", async () => {
    const [r] = await withDb(e, (sql) => begin(sql, (tx) => tx`SHOW statement_timeout`));
    expect(r!.statement_timeout).toBe(`${PG_STATEMENT_TIMEOUT_MS / 1000}s`);
  });
});
