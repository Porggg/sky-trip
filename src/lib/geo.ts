export type LngLat = [number, number];

const R = 6371008.8;
const rad = Math.PI / 180;

export function distance(a: LngLat | number[], b: LngLat | number[]): number {
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Cumulative distance (m) at each vertex of a line. */
export function cumulative(coords: number[][]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + distance(coords[i - 1], coords[i]);
  return out;
}

/** Point located `target` metres along a line, given its cumulative distances. */
export function along(coords: number[][], cum: number[], target: number): LngLat {
  if (target <= 0) return [coords[0][0], coords[0][1]];
  const last = coords.length - 1;
  if (target >= cum[last]) return [coords[last][0], coords[last][1]];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid;
    else hi = mid;
  }
  const t = (target - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
}

export function bbox(coords: number[][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}
