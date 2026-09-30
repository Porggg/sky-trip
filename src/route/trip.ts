// The trip being planned: ordered waypoints, routing settings and the routed legs between them.
import { Emitter } from '../lib/emitter';
import { cumulative, distance, type LngLat } from '../lib/geo';
import { routeLeg, RoutingError, PROFILES, supportsPriority, type CycleRoutePriority, type Leg } from './brouter';

export type WaypointKind = 'place' | 'station' | 'lodging';

export interface Waypoint {
  id: string;
  lngLat: LngLat;
  name?: string;
  kind?: WaypointKind;
}

export interface TripSettings {
  profile: string;
  /** How far the router may detour to stay on signposted cycle routes. */
  priority: CycleRoutePriority;
  kmPerDay: number;
  /** Departure day, YYYY-MM-DD. */
  startDate: string;
}

export interface RouteSummary {
  coords: number[][];
  cum: number[];
  length: number;
  ascent: number;
  time: number;
  onCycleRoute: number;
  carFree: number;
  unpaved: number;
  /** Index in `coords` where each leg starts. */
  legStarts: number[];
  /** Legs routed with a lower cycle-route priority than asked, because the server was overloaded. */
  reducedLegs: number;
}

export type RoutingStatus =
  | { state: 'idle' }
  /** `slow` turns true when the server takes unusually long. */
  | { state: 'routing'; done: number; total: number; slow: boolean }
  | { state: 'error'; message: string; canRetry: boolean };

const SLOW_AFTER_MS = 10_000;

interface TripEvents extends Record<string, unknown> {
  waypoints: Waypoint[];
  settings: TripSettings;
  route: RouteSummary | null;
  status: RoutingStatus;
}

let nextId = 1;
const newId = () => `wp${nextId++}`;

function nextFriday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return new Intl.DateTimeFormat('en-CA').format(d);
}

export const DEFAULT_SETTINGS: TripSettings = { profile: PROFILES[0].id, priority: 'strong', kmPerDay: 60, startDate: nextFriday() };

export class Trip extends Emitter<TripEvents> {
  waypoints: Waypoint[] = [];
  settings: TripSettings = { ...DEFAULT_SETTINGS };
  route: RouteSummary | null = null;
  status: RoutingStatus = { state: 'idle' };
  /** True from a change until its route has been computed (or failed). */
  pending = false;

  private legCache = new Map<string, Promise<Leg>>();
  /** Cached legs routed with a lower priority than asked, dropped on retry. */
  private reducedKeys = new Set<string>();
  private routeTimer: number | undefined;
  private generation = 0;

  // ——— waypoint editing ———

  setStart(lngLat: LngLat, meta: Partial<Waypoint> = {}) {
    const wp = { id: newId(), lngLat, ...meta };
    if (this.waypoints.length >= 2) this.waypoints[0] = wp;
    else if (this.waypoints.length === 1) this.waypoints = [wp, this.waypoints[0]];
    else this.waypoints = [wp];
    this.changed();
  }

  setEnd(lngLat: LngLat, meta: Partial<Waypoint> = {}) {
    const wp = { id: newId(), lngLat, ...meta };
    if (this.waypoints.length >= 2) this.waypoints[this.waypoints.length - 1] = wp;
    else this.waypoints.push(wp);
    this.changed();
  }

  /** Inserts a stop where it lengthens the trip the least. */
  addVia(lngLat: LngLat, meta: Partial<Waypoint> = {}) {
    const wp = { id: newId(), lngLat, ...meta };
    const pts = this.waypoints;
    if (pts.length < 2) {
      pts.push(wp);
    } else {
      let best = pts.length;
      let bestCost = distance(pts[pts.length - 1].lngLat, lngLat);
      for (let i = 0; i < pts.length - 1; i++) {
        const cost = distance(pts[i].lngLat, lngLat) + distance(lngLat, pts[i + 1].lngLat) - distance(pts[i].lngLat, pts[i + 1].lngLat);
        if (cost < bestCost) {
          bestCost = cost;
          best = i + 1;
        }
      }
      pts.splice(best, 0, wp);
    }
    this.changed();
  }

  move(id: string, lngLat: LngLat) {
    const wp = this.waypoints.find((w) => w.id === id);
    if (!wp) return;
    wp.lngLat = lngLat;
    wp.name = undefined;
    wp.kind = 'place';
    this.changed();
  }

  rename(id: string, name: string) {
    const wp = this.waypoints.find((w) => w.id === id);
    if (wp && !wp.name) {
      wp.name = name;
      this.emit('waypoints', this.waypoints);
    }
  }

  remove(id: string) {
    this.waypoints = this.waypoints.filter((w) => w.id !== id);
    this.changed();
  }

  shift(id: string, delta: -1 | 1) {
    const i = this.waypoints.findIndex((w) => w.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.waypoints.length) return;
    [this.waypoints[i], this.waypoints[j]] = [this.waypoints[j], this.waypoints[i]];
    this.changed();
  }

  reverse() {
    this.waypoints.reverse();
    this.changed();
  }

  closeLoop() {
    const first = this.waypoints[0];
    if (!first || this.waypoints.length < 2) return;
    this.waypoints.push({ ...first, id: newId() });
    this.changed();
  }

  clear() {
    this.waypoints = [];
    this.changed();
  }

  load(waypoints: Omit<Waypoint, 'id'>[], settings: Partial<TripSettings>) {
    this.waypoints = waypoints.map((w) => ({ ...w, id: newId() }));
    this.settings = { ...this.settings, ...settings };
    this.emit('settings', this.settings);
    this.changed();
  }

  update(settings: Partial<TripSettings>) {
    const reroute =
      (settings.profile && settings.profile !== this.settings.profile) || (settings.priority && settings.priority !== this.settings.priority);
    this.settings = { ...this.settings, ...settings };
    this.emit('settings', this.settings);
    if (reroute) this.scheduleRouting();
  }

  // ——— routing ———

  /** Stops waiting for the current computation (requests already sent still fill the cache). */
  cancel() {
    if (this.status.state !== 'routing') return;
    this.generation++;
    window.clearTimeout(this.routeTimer);
    this.pending = false;
    this.setStatus({ state: 'error', message: 'Calcul interrompu.', canRetry: true });
  }

  retry() {
    this.reducedKeys.forEach((key) => this.legCache.delete(key));
    this.reducedKeys.clear();
    this.scheduleRouting();
  }

  private changed() {
    this.emit('waypoints', this.waypoints);
    this.scheduleRouting();
  }

  private scheduleRouting() {
    this.pending = true;
    window.clearTimeout(this.routeTimer);
    this.routeTimer = window.setTimeout(() => void this.computeRoute(), 120);
  }

  private legKey(a: Waypoint, b: Waypoint) {
    const f = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    return `${this.settings.profile}|${this.settings.priority}|${f(a.lngLat)}|${f(b.lngLat)}`;
  }

  private getLeg(a: Waypoint, b: Waypoint): Promise<Leg> {
    const key = this.legKey(a, b);
    let leg = this.legCache.get(key);
    if (!leg) {
      const { profile, priority } = this.settings;
      leg = routeLeg(a.lngLat, b.lngLat, profile, priority);
      this.legCache.set(key, leg);
      leg.then(
        (l) => supportsPriority(profile) && l.priority !== priority && this.reducedKeys.add(key),
        () => this.legCache.delete(key),
      );
    }
    return leg;
  }

  private setStatus(status: RoutingStatus) {
    this.status = status;
    this.emit('status', status);
  }

  private async computeRoute() {
    const generation = ++this.generation;
    const pts = [...this.waypoints];
    if (pts.length < 2) {
      this.pending = false;
      this.route = null;
      this.setStatus({ state: 'idle' });
      this.emit('route', null);
      return;
    }
    const total = pts.length - 1;
    let done = 0;
    let slow = false;
    const progress = () => generation === this.generation && this.setStatus({ state: 'routing', done, total, slow });
    progress();
    const slowTimer = window.setTimeout(() => {
      slow = true;
      progress();
    }, SLOW_AFTER_MS);
    try {
      // Two legs at a time keeps us polite with the public BRouter server.
      const legs: Leg[] = new Array(total);
      let cursor = 0;
      const worker = async () => {
        while (cursor < legs.length && generation === this.generation) {
          const i = cursor++;
          legs[i] = await this.getLeg(pts[i], pts[i + 1]);
          done++;
          progress();
        }
      };
      await Promise.all([worker(), worker()]);
      if (generation !== this.generation) return;
      this.pending = false;
      const reduced = supportsPriority(this.settings.profile) ? legs.filter((l) => l.priority !== this.settings.priority).length : 0;
      this.route = combine(legs, reduced);
      this.setStatus({ state: 'idle' });
      this.emit('route', this.route);
    } catch (err) {
      if (generation !== this.generation) return;
      this.pending = false;
      this.setStatus(errorStatus(err, total));
    } finally {
      window.clearTimeout(slowTimer);
    }
  }
}

function errorStatus(err: unknown, legs: number): RoutingStatus {
  if (!(err instanceof RoutingError)) return { state: 'error', message: 'Le calcul de l’itinéraire a échoué.', canRetry: true };
  switch (err.kind) {
    case 'busy':
    case 'timeout':
      return {
        state: 'error',
        message:
          'Le serveur de calcul (BRouter, gratuit) est surchargé pour le moment.' +
          (legs === 1 ? ' Ajouter une étape au milieu raccourcit le calcul.' : ' Réessayez dans un instant.'),
        canRetry: true,
      };
    case 'offline':
      return { state: 'error', message: err.message, canRetry: true };
    default:
      return { state: 'error', message: err.message, canRetry: false };
  }
}

function combine(legs: Leg[], reducedLegs: number): RouteSummary {
  const coords: number[][] = [];
  const legStarts: number[] = [];
  const sum = { length: 0, ascent: 0, time: 0, onCycleRoute: 0, carFree: 0, unpaved: 0 };
  for (const leg of legs) {
    legStarts.push(Math.max(0, coords.length - 1));
    coords.push(...(coords.length ? leg.coords.slice(1) : leg.coords));
    for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += leg[key];
  }
  return { coords, cum: cumulative(coords), legStarts, reducedLegs, ...sum };
}
