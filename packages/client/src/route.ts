import { haversineM, type LatLng } from "@gojek/core";
import { env } from "./env";

export interface Route {
  points: LatLng[];
  distanceM: number;
  durationS: number;
  source: "osrm" | "straight";
}

/** OSRM base URL; VITE_OSRM_URL=off always uses straight lines (e.g. deterministic tests). */
const OSRM = env.VITE_OSRM_URL;
const AVG_SPEED_MS = 8; // fallback ETA for straight lines (~30 km/h)

const cache = new Map<string, Promise<Route>>();
const key = (p: LatLng) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;

export function straightRoute(from: LatLng, to: LatLng): Route {
  const d = haversineM(from, to);
  return { points: [from, to], distanceM: d, durationS: d / AVG_SPEED_MS, source: "straight" };
}

/** Road route via OSRM (cached); falls back to a straight line if OSRM is off or fails. */
export function getRoute(from: LatLng, to: LatLng): Promise<Route> {
  if (OSRM === "off") return Promise.resolve(straightRoute(from, to));
  const k = `${key(from)};${key(to)}`;
  let p = cache.get(k);
  if (!p) {
    p = fetchOsrm(from, to).catch(() => {
      cache.delete(k);
      return straightRoute(from, to);
    });
    cache.set(k, p);
  }
  return p;
}

async function fetchOsrm(from: LatLng, to: LatLng): Promise<Route> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`${OSRM}/route/v1/driving/${key(from)};${key(to)}?overview=full&geometries=geojson`, { signal: ctl.signal });
    const json = (await res.json()) as { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] };
    const r = json.routes?.[0];
    if (json.code !== "Ok" || !r) throw new Error(`osrm ${json.code}`);
    // OSRM snaps to the nearest road: pin the exact start/end so markers and the path meet
    const pts = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    return { points: [from, ...pts, to], distanceM: r.distance, durationS: r.duration, source: "osrm" };
  } finally {
    clearTimeout(t);
  }
}

export function pathLength(points: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineM(points[i - 1]!, points[i]!);
  return d;
}

/** Path from `pos` onward: drop the points already passed (nearest vertex and before). */
export function trimFrom(points: LatLng[], pos: LatLng): LatLng[] {
  if (points.length < 2) return [pos, ...points];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineM(points[i]!, pos);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return [pos, ...points.slice(best + 1)];
}

/**
 * Move `meters` along `path` starting at `pos`. Returns the new position and the
 * remaining waypoints (empty when the end is reached).
 */
export function advanceAlong(pos: LatLng, path: LatLng[], meters: number): { pos: LatLng; path: LatLng[]; heading: number | null } {
  let cur = pos;
  let left = meters;
  const rest = [...path];
  let heading: number | null = null;
  while (rest.length && left > 0) {
    const next = rest[0]!;
    const d = haversineM(cur, next);
    if (d > 0) heading = (Math.atan2(next.lng - cur.lng, next.lat - cur.lat) * 180) / Math.PI;
    if (d <= left) {
      cur = next;
      left -= d;
      rest.shift();
    } else {
      const f = left / d;
      cur = { lat: cur.lat + (next.lat - cur.lat) * f, lng: cur.lng + (next.lng - cur.lng) * f };
      left = 0;
    }
  }
  return { pos: cur, path: rest, heading };
}
