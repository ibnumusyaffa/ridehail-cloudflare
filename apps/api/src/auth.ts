import type { Role } from "@gojek/core";
import { sign, verify } from "hono/jwt";

export interface Principal {
  sub: string;
  role: Role;
  name: string;
}

const TOKEN_TTL_S = 30 * 24 * 3600;

function secret(env: Env): string {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return env.JWT_SECRET;
}

export function issueToken(env: Env, p: Principal): Promise<string> {
  return sign({ ...p, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }, secret(env), "HS256");
}

export async function readToken(env: Env, token: string | undefined | null): Promise<Principal | null> {
  if (!token) return null;
  try {
    const p = (await verify(token, secret(env), "HS256")) as Record<string, unknown>;
    if (typeof p.sub !== "string" || (p.role !== "customer" && p.role !== "driver")) return null;
    return { sub: p.sub, role: p.role, name: typeof p.name === "string" ? p.name : "" };
  } catch {
    return null;
  }
}
