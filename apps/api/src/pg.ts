import postgres from "postgres";

/** int8 (BIGINT: money, epoch ms, COUNT) parsed as a JS number — every value we store fits in 2^53. */
const int8AsNumber = { from: [20], parse: (raw: string) => Number(raw) } satisfies postgres.PostgresType<number>;

export type Sql = postgres.Sql<{ bigint: number }>;
export type Tx = postgres.TransactionSql<{ bigint: number }>;

/**
 * A short-lived client. Hyperdrive pools the real connections, so open one per request (Worker)
 * or per operation (Durable Object) and end it afterwards.
 */
export function connect(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    onnotice: () => {},
    types: { bigint: int8AsNumber },
  }) as unknown as Sql;
}

export async function withDb<T>(env: Env, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = connect(env);
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** Postgres unique violation (SQLSTATE 23505), optionally on a given constraint/index. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint_name?: string } | null;
  return err?.code === "23505" && (constraint === undefined || err.constraint_name === constraint);
}
