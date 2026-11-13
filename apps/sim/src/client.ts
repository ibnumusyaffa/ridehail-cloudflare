// Tiny REST + WebSocket client shared by the simulator and the demo.
export const API = process.env.API_URL ?? "http://localhost:8787";

export async function http<T = any>(path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(json)}`);
  return json as T;
}

export function wsUrl(query: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  return `${API.replace(/^http/, "ws")}/ws?${qs}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => min + Math.random() * (max - min);
