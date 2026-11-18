import type { LatLng, Place } from "@gojek/core";
import { env } from "./env";
import { PRESET_TRIPS } from "./presets";

export interface PlaceHit extends Place {
  /** second line: street / district / city */
  sub?: string;
  source: "preset" | "photon";
}

/** Photon (OSM) geocoder; VITE_GEOCODER_URL=off searches only the built-in places (e.g. deterministic tests). */
const PHOTON = env.VITE_GEOCODER_URL;
/** keeps type-ahead results local (Greater Jakarta by default). minLon,minLat,maxLon,maxLat */
const BBOX = env.VITE_GEOCODER_BBOX;

/** Named places the simulator already knows (preset pickups and dropoffs), deduped by label. */
const KNOWN: PlaceHit[] = [
  ...new Map(PRESET_TRIPS.flatMap((t) => [t.pickup, t.dropoff]).map((p) => [p.label, { ...p, sub: "Tempat populer", source: "preset" as const }])).values(),
];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "");

export function knownPlaces(q = ""): PlaceHit[] {
  const n = norm(q.trim());
  return n ? KNOWN.filter((p) => norm(p.label ?? "").includes(n)) : KNOWN;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function toHit(f: PhotonFeature): PlaceHit {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(" ");
  const label = p.name ?? (street || p.district || p.city || "Lokasi");
  const sub = [...new Set([p.name ? street : "", p.district, p.city ?? p.county].filter((s): s is string => !!s && s !== label))].join(", ");
  return { lat, lng, label, sub: sub || undefined, source: "photon" };
}

async function photon(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<PhotonFeature[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  signal?.addEventListener("abort", () => ctl.abort());
  try {
    const r = await fetch(`${PHOTON}${path}?${new URLSearchParams(params)}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`photon ${r.status}`);
    return ((await r.json()) as { features: PhotonFeature[] }).features ?? [];
  } finally {
    clearTimeout(t);
  }
}

/** Type-ahead address search: built-in places first, then Photon results near `near`. Never throws. */
export async function searchPlaces(q: string, near?: LatLng, signal?: AbortSignal): Promise<PlaceHit[]> {
  const local = knownPlaces(q);
  if (PHOTON === "off" || q.trim().length < 3) return local;
  try {
    const params: Record<string, string> = { q, limit: "8", bbox: BBOX };
    if (near) Object.assign(params, { lat: String(near.lat), lon: String(near.lng) });
    // Photon often returns one place several times (node + way + relation): one entry per name/address
    const hits = [...new Map((await photon("/api", params, signal)).map(toHit).map((h) => [`${h.label}|${h.sub}`, h])).values()];
    // drop remote hits that sit on top of a built-in place
    const remote = hits.filter((h) => !local.some((l) => Math.abs(l.lat - h.lat) < 3e-4 && Math.abs(l.lng - h.lng) < 3e-4));
    return [...local, ...remote];
  } catch {
    if (signal?.aborted) return [];
    return local;
  }
}

/** Best-effort name for a tapped map point; `null` when the geocoder is off or fails. */
export async function reverseGeocode(p: LatLng): Promise<PlaceHit | null> {
  if (PHOTON === "off") return null;
  try {
    const [f] = await photon("/reverse", { lat: String(p.lat), lon: String(p.lng), limit: "1" });
    return f ? { ...toHit(f), lat: p.lat, lng: p.lng } : null;
  } catch {
    return null;
  }
}
