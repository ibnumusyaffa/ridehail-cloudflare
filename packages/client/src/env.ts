import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Build-time config of the simulators (Vite inlines `import.meta.env.VITE_*`). Set in the app's `.env.local`
// or the shell, e.g. `VITE_API_URL=https://api.example.com pnpm build`.

/** a URL, or "off" to disable that external service (deterministic tests) */
const urlOrOff = (d: string) => z.union([z.literal("off"), z.url()]).default(d);

/** minLon,minLat,maxLon,maxLat */
const bbox = z
  .string()
  .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, "expected minLon,minLat,maxLon,maxLat");

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_API_URL: z.url().default("http://localhost:8787"),
    /** OSRM routing; "off" = straight lines */
    VITE_OSRM_URL: urlOrOff("https://router.project-osrm.org"),
    /** Photon (OSM) geocoder; "off" = built-in places only */
    VITE_GEOCODER_URL: urlOrOff("https://photon.komoot.io"),
    /** keeps type-ahead results local; default Greater Jakarta */
    VITE_GEOCODER_BBOX: bbox.default("106.4,-6.65,107.2,-5.9"),
    VITE_MAP_STYLE: z.url().default("https://tiles.openfreemap.org/styles/liberty"),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});
