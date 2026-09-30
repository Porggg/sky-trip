// Small Overpass API client. Public Overpass servers are often busy, so requests are
// "hedged": if a mirror has not answered after a few seconds, the next one is tried in
// parallel, and the first good answer wins (the others are cancelled).
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEDGE_DELAY_MS = 6_000;
const REQUEST_TIMEOUT_MS = 40_000;

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

let preferred = 0;

export function overpass(query: string, signal?: AbortSignal): Promise<OsmElement[]> {
  const order = MIRRORS.map((_, i) => (preferred + i) % MIRRORS.length);
  const controllers: AbortController[] = [];
  const timers: number[] = [];

  return new Promise<OsmElement[]>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let lastError: unknown = new Error('Overpass indisponible');

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      controllers.forEach((c) => c.abort());
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    signal?.addEventListener('abort', onAbort);

    const launched = new Set<number>();
    const launch = (step: number) => {
      if (settled || step >= order.length || launched.has(step)) return;
      launched.add(step);
      const index = order[step];
      const controller = new AbortController();
      controllers.push(controller);
      timers.push(window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS));
      // Start the next mirror if this one is slow to answer.
      timers.push(window.setTimeout(() => launch(step + 1), HEDGE_DELAY_MS));
      fetch(MIRRORS[index], { method: 'POST', body: new URLSearchParams({ data: query }), signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Overpass ${res.status}`);
          const data = await res.json();
          preferred = index;
          finish(() => resolve(data.elements ?? []));
        })
        .catch((err) => {
          lastError = err;
          failures++;
          if (failures === order.length) finish(() => reject(lastError));
          // A quick failure (e.g. 504) should not wait for the hedge delay.
          else launch(step + 1);
        });
    };
    launch(0);
  });
}
