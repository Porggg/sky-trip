// Bike routing with BRouter (https://brouter.de), an open-source router built on
// OpenStreetMap whose trekking profiles favour cycle routes and greenways.
import type { LngLat } from '../lib/geo';

const ENDPOINT = 'https://brouter.de/brouter';

export interface RoutingProfile {
  id: string;
  label: string;
  hint: string;
}

export const PROFILES: RoutingProfile[] = [
  { id: 'trekking', label: 'Véloroutes', hint: 'Privilégie les véloroutes et voies vertes balisées' },
  { id: 'safety', label: 'Au calme', hint: 'Évite au maximum la circulation, quitte à allonger' },
  { id: 'fastbike-lowtraffic', label: 'Direct', hint: 'Routes secondaires peu fréquentées, plus rapide' },
  { id: 'gravel', label: 'Gravel', hint: 'Accepte chemins et pistes non revêtues' },
];

export type CycleRoutePriority = 'normal' | 'strong' | 'max';

export const PRIORITIES: { id: CycleRoutePriority; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normale', hint: 'Le réglage d’origine du profil : quelques détours pour rester sur les véloroutes.' },
  { id: 'strong', label: 'Forte', hint: 'Accepte des détours plus longs pour rester sur les véloroutes balisées.' },
  { id: 'max', label: 'Maximale', hint: 'Suit les véloroutes presque partout, quitte à rallonger nettement le trajet.' },
];

/**
 * How each profile can be pushed towards cycle routes. "strong" uses the profile's own
 * switch (passed in the URL); "max" uploads a copy of the profile with a higher cost for
 * every way that is not part of a cycle route.
 */
const TUNING: Record<string, { strong: Record<string, string>; max: (brf: string) => string } | undefined> = {
  trekking: {
    strong: { stick_to_cycleroutes: '1' },
    max: (brf) => brf.replace('add ( if stick_to_cycleroutes then 0.5 else 0.05 )', 'add 1.2'),
  },
  safety: {
    strong: { stick_to_cycleroutes: '1' },
    max: (brf) => brf.replace('add ( if stick_to_cycleroutes then 0.5 else 0.05 )', 'add 1.2'),
  },
  gravel: {
    strong: { prefer_cycle_routes: '1' },
    max: (brf) => brf.replace('switch not prefer_cycle_routes 1.03 1.85', '2.6'),
  },
};

export function supportsPriority(profile: string): boolean {
  return !!TUNING[profile];
}

// brouter.de does not serve its profile files to browsers (no CORS), so we ship copies
// (BRouter, MIT licence), loaded only when "max" is chosen. Refresh them with:
//   curl -o src/route/profiles/trekking.brf https://brouter.de/brouter/profiles2/trekking.brf
const PROFILE_SOURCES = import.meta.glob<string>('./profiles/*.brf', { query: '?raw', import: 'default' });

const customProfiles = new Map<string, Promise<string>>();

/** Uploads the "max" variant of a profile once per session and returns its server id. */
function customProfile(profile: string, forceUpload = false): Promise<string> {
  let id = customProfiles.get(profile);
  if (!id || forceUpload) {
    id = (async () => {
      const load = PROFILE_SOURCES[`./profiles/${profile}.brf`];
      if (!load) throw new Error(`Profil ${profile} non embarqué`);
      const base = await load();
      const patched = TUNING[profile]!.max(base);
      if (patched === base) throw new Error(`Profil ${profile} : réglage introuvable`);
      const res = await fetch(`${ENDPOINT}/profile`, { method: 'POST', body: patched });
      const data = await res.json();
      if (!data.profileid) throw new Error(data.error ?? 'Envoi du profil refusé');
      return data.profileid as string;
    })();
    customProfiles.set(profile, id);
    id.catch(() => customProfiles.delete(profile));
  }
  return id;
}

/** Profile name and extra URL parameters for a profile + priority. */
async function resolveProfile(profile: string, priority: CycleRoutePriority, forceUpload = false): Promise<string> {
  const tuning = TUNING[profile];
  if (!tuning || priority === 'normal') return `profile=${encodeURIComponent(profile)}`;
  if (priority === 'strong') {
    const params = Object.entries(tuning.strong).map(([k, v]) => `&profile:${k}=${v}`);
    return `profile=${encodeURIComponent(profile)}${params.join('')}`;
  }
  try {
    return `profile=${encodeURIComponent(await customProfile(profile, forceUpload))}`;
  } catch (err) {
    // The upload failed: fall back to the strongest built-in setting.
    console.warn('Profil « Maximale » indisponible, repli sur « Forte »', err);
    return resolveProfile(profile, 'strong');
  }
}

/** One routed section between two consecutive waypoints. */
export interface Leg {
  /** [lng, lat, ele] */
  coords: number[][];
  length: number;
  ascent: number;
  time: number;
  /** Per-segment surface & infrastructure breakdown, in metres. */
  onCycleRoute: number;
  carFree: number;
  unpaved: number;
  /** Cycle-route priority actually used (lower than asked if the server was overloaded). */
  priority: CycleRoutePriority;
}

const CAR_FREE = /\bhighway=(cycleway|path|footway|pedestrian|bridleway)\b|\bbicycle_road=yes\b|\bcyclestreet=yes\b/;
const TRACK_CAR_FREE = /\bhighway=track\b/;
const UNPAVED = /\bsurface=(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|mud|sand|pebblestone|woodchips)\b|\btracktype=grade[3-5]\b/;
const CYCLE_ROUTE = /\broute_bicycle_(icn|ncn|rcn|lcn)=yes\b/;

function analyse(messages: string[][]) {
  const header = messages[0];
  const iDist = header.indexOf('Distance');
  const iTags = header.indexOf('WayTags');
  let onCycleRoute = 0;
  let carFree = 0;
  let unpaved = 0;
  for (let i = 1; i < messages.length; i++) {
    const d = Number(messages[i][iDist]) || 0;
    const tags = messages[i][iTags] ?? '';
    if (CYCLE_ROUTE.test(tags)) onCycleRoute += d;
    if (CAR_FREE.test(tags) || (TRACK_CAR_FREE.test(tags) && !/motor_vehicle=(yes|destination)/.test(tags))) carFree += d;
    if (UNPAVED.test(tags)) unpaved += d;
  }
  return { onCycleRoute, carFree, unpaved };
}

/** Why a leg could not be routed; "busy" and "timeout" are worth retrying later. */
export type RoutingErrorKind = 'busy' | 'timeout' | 'offline' | 'unreachable' | 'no-route' | 'other';

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly kind: RoutingErrorKind = 'other',
    readonly status?: number,
  ) {
    super(message);
  }
}

// Past this, a request is abandoned. BRouter normally answers in a few seconds, but the
// public server slows down a lot under load.
const REQUEST_TIMEOUT_MS = 30_000;
// Overall budget per leg, fallbacks included.
const LEG_BUDGET_MS = 75_000;
const LOWER: Record<CycleRoutePriority, CycleRoutePriority | null> = { max: 'strong', strong: 'normal', normal: null };

/**
 * Routes one leg. When the server is overloaded it kills long computations — and a
 * strong cycle-route priority makes them longer — so we step down the priority rather
 * than fail, and report which priority was actually used.
 */
export async function routeLeg(
  from: LngLat,
  to: LngLat,
  profile: string,
  priority: CycleRoutePriority = 'normal',
  signal?: AbortSignal,
): Promise<Leg> {
  let current: CycleRoutePriority | null = supportsPriority(profile) ? priority : 'normal';
  let lastError: unknown;
  let retriedNormal = false;
  const deadline = Date.now() + LEG_BUDGET_MS;
  while (current && Date.now() < deadline) {
    try {
      const leg = await requestLeg(from, to, await resolveProfile(profile, current), signal);
      return { ...leg, priority: current };
    } catch (err) {
      if (!(err instanceof RoutingError)) throw err;
      lastError = err;
      // Uploaded profiles expire on the server after a while (it then answers 500 with
      // no message): upload again and retry once.
      if (current === 'max' && err.status === 500) {
        try {
          const leg = await requestLeg(from, to, await resolveProfile(profile, 'max', true), signal);
          return { ...leg, priority: 'max' };
        } catch (retryErr) {
          lastError = retryErr;
        }
      }
      const transient = err.kind === 'busy' || err.kind === 'timeout' || err.status === 500;
      if (!transient) throw err;
      if (LOWER[current]) {
        current = LOWER[current];
      } else if (!retriedNormal && err.kind === 'busy') {
        // Last chance on the plainest profile, after a short pause.
        retriedNormal = true;
        await new Promise((r) => setTimeout(r, 2500));
      } else {
        current = null;
      }
    }
  }
  throw lastError;
}

async function requestLeg(from: LngLat, to: LngLat, profileQuery: string, signal?: AbortSignal): Promise<Omit<Leg, 'priority'>> {
  const lonlats = `${from[0].toFixed(6)},${from[1].toFixed(6)}|${to[0].toFixed(6)},${to[1].toFixed(6)}`;
  const url = `${ENDPOINT}?lonlats=${lonlats}&${profileQuery}&alternativeidx=0&format=geojson`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { signal: controller.signal });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new RoutingError('Le serveur de calcul met trop de temps à répondre.', 'timeout');
    }
    throw new RoutingError('Le service de calcul d’itinéraire ne répond pas. Vérifiez votre connexion.', 'offline');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
  if (!res.ok) {
    if (/not mapped|no track|position not mapped/i.test(text)) {
      throw new RoutingError('Un point est trop loin d’une route ou d’un chemin praticable.', 'unreachable', res.status);
    }
    if (/watchdog|killed|timeout|too many|busy/i.test(text) || res.status === 503 || res.status === 429) {
      throw new RoutingError('Le serveur de calcul est surchargé.', 'busy', res.status);
    }
    throw new RoutingError(`Calcul impossible (${res.status}). ${text.slice(0, 120)}`, 'other', res.status);
  }
  const data = JSON.parse(text);
  const feature = data.features?.[0];
  if (!feature) throw new RoutingError('Aucun itinéraire trouvé entre ces deux points.', 'no-route');
  const p = feature.properties;
  return {
    coords: feature.geometry.coordinates,
    length: Number(p['track-length']) || 0,
    ascent: Number(p['filtered ascend']) || 0,
    time: Number(p['total-time']) || 0,
    ...analyse(p.messages ?? [[]]),
  };
}
