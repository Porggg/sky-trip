// Serialises a trip into the URL (?trip=…) so it can be shared or bookmarked,
// and keeps a copy in localStorage so a reload does not lose work.
import type { Trip, TripSettings, Waypoint } from './trip';

interface Packed {
  v: 1;
  /** [lng, lat, name, kind] — name is empty when unknown. */
  w: [number, number, string?, string?][];
  p: string;
  /** Cycle route priority; absent in links made before it existed. */
  r?: string;
  k: number;
  d: string;
}

const STORAGE_KEY = 'sky-trip:current';

function encode(value: Packed): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text: string): Packed | null {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value?.v === 1 && Array.isArray(value.w) ? value : null;
  } catch {
    return null;
  }
}

function pack(trip: Trip): Packed {
  return {
    v: 1,
    w: trip.waypoints.map((w) => {
      const entry: [number, number, string?, string?] = [+w.lngLat[0].toFixed(5), +w.lngLat[1].toFixed(5)];
      if (w.kind && w.kind !== 'place') entry.push(w.name ?? '', w.kind);
      else if (w.name) entry.push(w.name);
      return entry;
    }),
    p: trip.settings.profile,
    r: trip.settings.priority,
    k: trip.settings.kmPerDay,
    d: trip.settings.startDate,
  };
}

function unpack(p: Packed): { waypoints: Omit<Waypoint, 'id'>[]; settings: Partial<TripSettings> } {
  return {
    waypoints: p.w.map(([lng, lat, name, kind]) => ({ lngLat: [lng, lat], name: name || undefined, kind: (kind as Waypoint['kind']) ?? 'place' })),
    settings: {
      profile: p.p,
      kmPerDay: p.k,
      startDate: p.d,
      ...(p.r === 'normal' || p.r === 'strong' || p.r === 'max' ? { priority: p.r } : {}),
    },
  };
}

export function shareUrl(trip: Trip): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (trip.waypoints.length) url.searchParams.set('trip', encode(pack(trip)));
  return url.toString();
}

/** Restores a trip from the URL first, then from the last session. Returns true if something was loaded. */
export function restore(trip: Trip): boolean {
  const fromUrl = new URLSearchParams(location.search).get('trip');
  let packed = fromUrl ? decode(fromUrl) : null;
  if (!packed) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      packed = saved ? decode(saved) : null;
    } catch {
      packed = null;
    }
  }
  if (!packed) return false;
  const { waypoints, settings } = unpack(packed);
  // Keep the saved departure date only if it is still in the future.
  if (settings.startDate && settings.startDate < new Intl.DateTimeFormat('en-CA').format(new Date())) delete settings.startDate;
  trip.load(waypoints, settings);
  return waypoints.length > 0;
}

export function persist(trip: Trip) {
  const save = () => {
    const packed = encode(pack(trip));
    try {
      localStorage.setItem(STORAGE_KEY, packed);
    } catch {
      // storage unavailable (private mode) — the URL still carries the trip
    }
    const url = new URL(location.href);
    if (trip.waypoints.length) url.searchParams.set('trip', packed);
    else url.searchParams.delete('trip');
    history.replaceState(null, '', url);
  };
  trip.on('waypoints', save);
  trip.on('settings', save);
}
