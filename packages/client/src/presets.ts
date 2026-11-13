import type { Place } from "@gojek/core";

export interface PresetTrip {
  id: string;
  name: string;
  pickup: Place;
  dropoff: Place;
}

/** Fixed Jakarta trips: used by the UI quick-pick and by Playwright for deterministic runs. */
export const PRESET_TRIPS: PresetTrip[] = [
  {
    id: "monas-hi",
    name: "Monas → Bundaran HI",
    pickup: { lat: -6.1754, lng: 106.8272, label: "Monas" },
    dropoff: { lat: -6.1949, lng: 106.823, label: "Bundaran HI" },
  },
  {
    id: "gbk-blokm",
    name: "GBK → Blok M",
    pickup: { lat: -6.2186, lng: 106.8023, label: "GBK" },
    dropoff: { lat: -6.2443, lng: 106.7998, label: "Blok M" },
  },
  {
    id: "kota-ancol",
    name: "Kota Tua → Ancol",
    pickup: { lat: -6.1352, lng: 106.8133, label: "Kota Tua" },
    dropoff: { lat: -6.1225, lng: 106.8335, label: "Ancol" },
  },
  {
    id: "kuningan-senopati",
    name: "Kuningan → Senopati",
    pickup: { lat: -6.2297, lng: 106.8295, label: "Kuningan" },
    dropoff: { lat: -6.2321, lng: 106.8098, label: "Senopati" },
  },
];

/** A spot ~300 m from a preset pickup, where a driver can wait for that trip. */
export function nearPickup(trip: PresetTrip, meters = 300): Place {
  return { lat: trip.pickup.lat + meters / 111_000, lng: trip.pickup.lng, label: `near ${trip.pickup.label}` };
}

export const JAKARTA = { lat: -6.2, lng: 106.8227 };
