import { along, type LngLat } from '../lib/geo';
import type { RouteSummary } from './trip';

export interface Stage {
  day: number;
  from: number;
  to: number;
  ascent: number;
  /** Where the day ends — the night spot, except for the last day. */
  end: LngLat;
  last: boolean;
}

/** Positive elevation gain with a small hysteresis to ignore DEM noise. */
function ascentBetween(route: RouteSummary, from: number, to: number): number {
  let gain = 0;
  let ref: number | null = null;
  for (let i = 0; i < route.coords.length; i++) {
    const d = route.cum[i];
    if (d < from) continue;
    if (d > to) break;
    const ele = route.coords[i][2];
    if (ele == null) continue;
    if (ref == null) ref = ele;
    else if (ele - ref > 4) {
      gain += ele - ref;
      ref = ele;
    } else if (ele < ref) ref = ele;
  }
  return gain;
}

/**
 * Splits the route into days of roughly `kmPerDay`. The last day absorbs a short remainder
 * rather than leaving a 5 km stub.
 */
export function splitStages(route: RouteSummary, kmPerDay: number): Stage[] {
  const daily = Math.max(10, kmPerDay) * 1000;
  let days = Math.max(1, Math.round(route.length / daily));
  if (route.length / days > daily * 1.25) days++;
  const stageLength = route.length / days;
  const stages: Stage[] = [];
  for (let day = 1; day <= days; day++) {
    const from = (day - 1) * stageLength;
    const to = day === days ? route.length : day * stageLength;
    stages.push({ day, from, to, ascent: ascentBetween(route, from, to), end: along(route.coords, route.cum, to), last: day === days });
  }
  // Our quick estimate differs from BRouter's filtered ascent; scale so days add up to the total.
  const sum = stages.reduce((s, st) => s + st.ascent, 0);
  if (sum > 0) stages.forEach((st) => (st.ascent *= route.ascent / sum));
  return stages;
}
