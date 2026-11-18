import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { LatLng } from "@gojek/core";
import { env } from "../env";

export type MarkerKind = "pickup" | "dropoff" | "driver" | "me";

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  kind: MarkerKind;
  title?: string;
  draggable?: boolean;
  heading?: number | null;
  onDragEnd?: (p: LatLng) => void;
}

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  markers: MapMarker[];
  /** polyline (e.g. driver → pickup → dropoff) */
  route?: LatLng[];
  onClick?: (p: LatLng) => void;
  /** change this key to re-fit the camera to `fitPoints` */
  fitKey?: string;
  fitPoints?: LatLng[];
}

const STYLE = env.VITE_MAP_STYLE;
const ICON: Record<MarkerKind, string> = { pickup: "📍", dropoff: "🏁", driver: "🛵", me: "🛵" };

function el(m: MapMarker) {
  const d = document.createElement("div");
  d.className = `mk mk-${m.kind}`;
  d.dataset.testid = `marker-${m.id}`;
  d.title = m.title ?? m.kind;
  d.textContent = ICON[m.kind];
  return d;
}

export function MapView({ center, zoom = 14, markers, route, onClick, fitKey, fitPoints }: MapViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const live = useRef(new Map<string, { marker: maplibregl.Marker; spec: MapMarker }>());
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const m = new maplibregl.Map({ container: box.current!, style: STYLE, center: [center.lng, center.lat], zoom, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("click", (e) => clickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    m.on("load", () => {
      m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#007aff", "line-width": 5 },
      });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      live.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // markers: diff by id
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const spec of markers) {
      seen.add(spec.id);
      const cur = live.current.get(spec.id);
      if (cur && cur.spec.kind === spec.kind && cur.spec.draggable === spec.draggable) {
        cur.marker.setLngLat([spec.lng, spec.lat]);
        if (spec.heading != null) cur.marker.setRotation(0);
        cur.spec = spec;
        continue;
      }
      cur?.marker.remove();
      const marker = new maplibregl.Marker({ element: el(spec), draggable: !!spec.draggable, anchor: spec.kind === "pickup" ? "bottom" : "center" })
        .setLngLat([spec.lng, spec.lat])
        .addTo(m);
      const entry = { marker, spec };
      marker.on("dragend", () => {
        const p = marker.getLngLat();
        entry.spec.onDragEnd?.({ lat: p.lat, lng: p.lng });
      });
      live.current.set(spec.id, entry);
    }
    for (const [id, { marker }] of live.current) {
      if (!seen.has(id)) {
        marker.remove();
        live.current.delete(id);
      }
    }
  }, [markers]);

  // route line
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: "FeatureCollection",
        features: route && route.length > 1
          ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.map((p) => [p.lng, p.lat]) } }]
          : [],
      });
    };
    if (m.isStyleLoaded() && m.getSource("route")) apply();
    else m.once("load", apply);
  }, [route]);

  // camera fit
  useEffect(() => {
    const m = map.current;
    if (!m || !fitKey || !fitPoints?.length) return;
    if (fitPoints.length === 1) {
      m.easeTo({ center: [fitPoints[0]!.lng, fitPoints[0]!.lat], zoom: 15 });
      return;
    }
    const b = new maplibregl.LngLatBounds();
    for (const p of fitPoints) b.extend([p.lng, p.lat]);
    m.fitBounds(b, { padding: { top: 60, left: 50, right: 50, bottom: 340 }, maxZoom: 16, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // maplibre forces `position: relative` on its container, so the absolute box is a wrapper
  return (
    <div className="map" data-testid="map">
      <div ref={box} className="map-inner" />
    </div>
  );
}
