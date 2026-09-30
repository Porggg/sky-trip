// Reads the World Atlas of Artificial Night Sky Brightness (David J. Lorenz, 2025 edition)
// directly from its binary tiles, so we can give the sky quality at any point of a trip.
//
// Tile format (from the atlas' own viewer): 5°×5° tiles, 600×600 points (1/120°), gzip.
// The first two bytes hold the lower-left value, every following byte is a delta.
import { gunzipSync } from 'fflate';

export const ATLAS_YEAR = 2025;
const BASE = `https://djlorenz.github.io/astronomy/binary_tiles/${ATLAS_YEAR}`;
const N = 600;

export interface SkyZone {
  id: string;
  /** Upper bound of the artificial/natural brightness ratio for this zone. */
  max: number;
  color: string;
  label: string;
}

// Colour scale of the atlas. Labels are ours; the author asks not to present them as Bortle classes.
export const ZONES: SkyZone[] = [
  { id: '0', max: 0.01, color: '#000000', label: 'Ciel vierge' },
  { id: '1a', max: 0.06, color: '#222222', label: 'Excellent' },
  { id: '1b', max: 0.11, color: '#424242', label: 'Excellent' },
  { id: '2a', max: 0.19, color: '#142f72', label: 'Très bon' },
  { id: '2b', max: 0.33, color: '#2154d8', label: 'Très bon' },
  { id: '3a', max: 0.58, color: '#0f5714', label: 'Bon' },
  { id: '3b', max: 1.0, color: '#1fa12a', label: 'Bon' },
  { id: '4a', max: 1.73, color: '#6e641e', label: 'Moyen' },
  { id: '4b', max: 3.0, color: '#b8a625', label: 'Moyen' },
  { id: '5a', max: 5.2, color: '#bf641e', label: 'Médiocre' },
  { id: '5b', max: 9.0, color: '#fd9650', label: 'Médiocre' },
  { id: '6a', max: 15.59, color: '#fb5a49', label: 'Mauvais' },
  { id: '6b', max: 27.0, color: '#fb998a', label: 'Mauvais' },
  { id: '7a', max: 46.77, color: '#a0a0a0', label: 'Très mauvais' },
  { id: '7b', max: Infinity, color: '#f2f2f2', label: 'Très mauvais' },
];

export interface SkyReading {
  /** Artificial brightness as a ratio of the natural sky brightness. */
  ratio: number;
  /** Zenith sky brightness, magnitudes per square arcsecond (higher is darker). */
  sqm: number;
  zone: SkyZone;
  milkyWay: 'bien visible' | 'visible' | 'faible' | 'invisible';
}

const tiles = new Map<string, Promise<Int16Array | null>>();

function tileKey(tx: number, ty: number) {
  return `${tx}_${ty}`;
}

async function loadTile(tx: number, ty: number): Promise<Int16Array | null> {
  const res = await fetch(`${BASE}/binary_tile_${tx}_${ty}.dat.gz`);
  if (!res.ok) return null;
  const bytes = gunzipSync(new Uint8Array(await res.arrayBuffer()));
  const d = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Rebuild the absolute grid once: walk up the first column, then along each row.
  const grid = new Int16Array(N * N);
  let column = 128 * d[0] + d[1];
  for (let iy = 1; iy <= N; iy++) {
    if (iy > 1) column += d[N * (iy - 1) + 1];
    let value = column;
    grid[(iy - 1) * N] = value;
    for (let ix = 2; ix <= N; ix++) {
      value += d[N * (iy - 1) + ix];
      grid[(iy - 1) * N + ix - 1] = value;
    }
  }
  return grid;
}

function getTile(tx: number, ty: number) {
  const key = tileKey(tx, ty);
  let p = tiles.get(key);
  if (!p) {
    p = loadTile(tx, ty).catch(() => null);
    tiles.set(key, p);
    // Drop failed tiles so a later call can retry.
    p.then((t) => t || tiles.delete(key));
  }
  return p;
}

function locate(lng: number, lat: number) {
  const lon = (((lng + 180) % 360) + 360) % 360;
  const la = lat + 65;
  const tx = Math.floor(lon / 5) + 1;
  const ty = Math.floor(la / 5) + 1;
  if (ty < 1 || ty > 28) return null;
  const ix = Math.max(1, Math.min(N, Math.round(120 * (lon - 5 * (tx - 1) + 1 / 240))));
  const iy = Math.max(1, Math.min(N, Math.round(120 * (la - 5 * (ty - 1) + 1 / 240))));
  return { tx, ty, ix, iy };
}

export function zoneFor(ratio: number): SkyZone {
  return ZONES.find((z) => ratio < z.max) ?? ZONES[ZONES.length - 1];
}

export function readingFromRatio(ratio: number): SkyReading {
  const sqm = 22 - (5 * Math.log(1 + ratio)) / Math.log(100);
  const milkyWay = sqm >= 21.2 ? 'bien visible' : sqm >= 20.5 ? 'visible' : sqm >= 19.8 ? 'faible' : 'invisible';
  return { ratio, sqm, zone: zoneFor(ratio), milkyWay };
}

/** Sky brightness at one point, or null outside the atlas (oceans far offshore, poles). */
export async function skyAt(lng: number, lat: number): Promise<SkyReading | null> {
  const loc = locate(lng, lat);
  if (!loc) return null;
  const grid = await getTile(loc.tx, loc.ty);
  if (!grid) return null;
  const compressed = grid[(loc.iy - 1) * N + loc.ix - 1];
  return readingFromRatio((5 / 195) * (Math.exp(0.0195 * compressed) - 1));
}

/** Samples many points at once, loading each tile only once. */
export async function skyAlong(points: number[][]): Promise<(SkyReading | null)[]> {
  const needed = new Set<string>();
  for (const [lng, lat] of points) {
    const loc = locate(lng, lat);
    if (loc) needed.add(tileKey(loc.tx, loc.ty));
  }
  await Promise.all([...needed].map((k) => getTile(...(k.split('_').map(Number) as [number, number]))));
  return Promise.all(points.map(([lng, lat]) => skyAt(lng, lat)));
}
