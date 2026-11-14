import postgres from "postgres";

/** int8 (BIGINT: money, epoch ms, COUNT) parsed as a JS number — every value we store fits in 2^53. */
const int8AsNumber = { from: [20], parse: (raw: string) => Number(raw) } satisfies postgres.PostgresType<number>;

export type Sql = postgres.Sql<{ bigint: number }>;
export type Tx = postgres.TransactionSql<{ bigint: number }>;

/**
 * Time limits, so a slow or unreachable Postgres fails fast instead of hanging every action:
 *  - CONNECT: TCP + auth handshake (postgres.js default is 30 s).
 *  - STATEMENT: server-side limit inside our transactions (`SET LOCAL`, safe with Hyperdrive's
 *    transaction pooling); a statement over it is cancelled and its locks released.
 *  - OPERATION: client-side deadline for one whole `withDb` call (connect + all queries).
 */
export const PG_CONNECT_TIMEOUT_S = 5;
export const PG_STATEMENT_TIMEOUT_MS = 5_000;
export const PG_OPERATION_TIMEOUT_MS = 8_000;

/** `withDb` gave up waiting on Postgres. The work may or may not have committed. */
export class DbTimeoutError extends Error {
  constructor(ms: number) {
    super(`postgres operation exceeded ${ms} ms`);
    this.name = "DbTimeoutError";
  }
}

/**
 * A short-lived client. Hyperdrive pools the real connections, so open one per request (Worker)
 * or per operation (Durable Object) and end it afterwards.
 */
export function connect(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    connect_timeout: PG_CONNECT_TIMEOUT_S,
    fetch_types: false,
    onnotice: () => {},
    types: { bigint: int8AsNumber },
  }) as unknown as Sql;
}

/**
 * Run `fn` on a fresh client and end it. Rejects with `DbTimeoutError` after `timeoutMs`; the client
 * is then closed immediately, so a hung connection never outlives the call.
 */
export async function withDb<T>(
  env: Env,
  fn: (sql: Sql) => Promise<T>,
  timeoutMs: number = PG_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const sql = connect(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new DbTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const work = fn(sql);
  work.catch(() => {}); // after a timeout its rejection (closed connection) is expected and unobserved
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: timedOut ? 0 : 1 }).catch(() => {});
  }
}

/** A transaction with the server-side statement limit applied. Use instead of `sql.begin`. */
export function begin<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${PG_STATEMENT_TIMEOUT_MS}`);
    return fn(tx);
  }) as Promise<T>;
}

/** Postgres unique violation (SQLSTATE 23505), optionally on a given constraint/index. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint_name?: string } | null;
  return err?.code === "23505" && (constraint === undefined || err.constraint_name === constraint);
}
