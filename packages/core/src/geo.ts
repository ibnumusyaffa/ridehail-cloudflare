import type { LatLng } from "./types";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const EARTH_RADIUS_M = 6_371_000;

export function geohashEncode(lat: number, lng: number, precision: number): string {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = "";
  let bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; } else { ch <<= 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export interface Bounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

export function geohashBounds(hash: string): Bounds {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let even = true;
  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error(`invalid geohash char: ${c}`);
    for (let n = 4; n >= 0; n--) {
      const bitOn = (idx >> n) & 1;
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (bitOn) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bitOn) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return { latMin, latMax, lngMin, lngMax };
}

export function isGeohash(s: string): boolean {
  return s.length > 0 && s.length <= 12 && [...s].every((c) => BASE32.includes(c));
}

/** The cell itself plus its 8 neighbours (deduplicated; poles/antimeridian clamp/wrap). */
export function geohashNeighborhood(hash: string): string[] {
  const b = geohashBounds(hash);
  const dLat = b.latMax - b.latMin;
  const dLng = b.lngMax - b.lngMin;
  const cLat = (b.latMin + b.latMax) / 2;
  const cLng = (b.lngMin + b.lngMax) / 2;
  const out = new Set<string>();
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      const lat = cLat + dy * dLat;
      if (lat > 90 || lat < -90) continue;
      let lng = cLng + dx * dLng;
      if (lng > 180) lng -= 360;
      if (lng < -180) lng += 360;
      out.add(geohashEncode(lat, lng, hash.length));
    }
  }
  return [...out];
}

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLng(p: unknown): p is LatLng {
  if (typeof p !== "object" || p === null) return false;
  const { lat, lng } = p as Record<string, unknown>;
  return (
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/** Every cell of `precision` inside `hash` (or `hash` itself when it is already that precise). */
export function geohashChildren(hash: string, precision: number): string[] {
  let out = [hash];
  for (let p = hash.length; p < precision; p++) out = out.flatMap((h) => [...BASE32].map((c) => h + c));
  return out;
}

/** Metres from `p` to the nearest edge of cell `hash`; negative when `p` lies outside it. */
export function distanceInsideCellM(p: LatLng, hash: string): number {
  const b = geohashBounds(hash);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  return Math.min(
    (p.lat - b.latMin) * mPerDegLat,
    (b.latMax - p.lat) * mPerDegLat,
    (p.lng - b.lngMin) * mPerDegLng,
    (b.lngMax - p.lng) * mPerDegLng,
  );
}

/** Initial bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
