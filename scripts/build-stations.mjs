// Builds public/data/stations.geojson from SNCF open data (GTFS):
//   - national feed: TER, TGV INOUI, OUIGO, Intercités (jour et nuit), ICE, Lyria, tram-train
//   - Transilien feed: RER and Transilien lines in Île-de-France
// Each station gets the list of rail services calling there, a few line names and the
// number of departures on a representative weekday.
//
// Usage: npm run data:stations
import { writeFile, mkdir } from 'node:fs/promises';
import { downloadCached, openZip, readTable, activeServices, representativeDate } from './lib/gtfs.mjs';

const NATIONAL_URL = 'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip';
const TRANSILIEN_URL = 'https://eu.ftp.opendatasoft.com/sncf/gtfs/transilien-gtfs.zip';
const OUT = 'public/data/stations.geojson';

// Stop point ids look like "StopPoint:OCETGV INOUI-87686006"; the middle part is the service.
const NATIONAL_SERVICES = {
  'Train TER': 'ter',
  Train: 'ter',
  'TGV INOUI': 'tgv',
  OUIGO: 'ouigo',
  INTERCITES: 'ic',
  'INTERCITES de nuit': 'icn',
  ICE: 'intl',
  Lyria: 'intl',
  TramTrain: 'tramtrain',
};
const TRANSILIEN_AGENCIES = { 'IDFM:71': 'rer', 'IDFM:1046': 'transilien' };

const round = (n) => Math.round(n * 1e5) / 1e5;

function normaliseName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(gare|de|du|des|la|le|les|d|l|sncf)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function distanceM(a, b) {
  const R = 6371e3;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Title-cases the ALL-CAPS names that some SNCF stops carry. */
function prettyName(raw) {
  const name = raw.replace(/\s+Hall\s+\d.*$/i, '').trim();
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s\-'’(])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function addLine(station, line) {
  station.lineCounts.set(line, (station.lineCounts.get(line) ?? 0) + 1);
}

function buildNational(zip, date) {
  const stations = new Map(); // stop area id → station
  const pointToArea = new Map();
  const pointService = new Map();

  const rows = [...readTable(zip, 'stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station'])];
  for (const r of rows) {
    // French stations carry a UIC code starting with 87; the feed also lists foreign stops.
    if (r.location_type === '1' && r.stop_id.startsWith('StopArea:OCE87')) {
      stations.set(r.stop_id, {
        id: r.stop_id.replace('StopArea:OCE', 'sncf-'),
        name: prettyName(r.stop_name),
        coord: [round(+r.stop_lon), round(+r.stop_lat)],
        services: new Set(),
        lineCounts: new Map(),
        departures: 0,
      });
    }
  }
  for (const r of rows) {
    if (r.location_type !== '0' || !stations.has(r.parent_station)) continue;
    const m = r.stop_id.match(/^StopPoint:OCE(.+)-\d+$/);
    const service = m && NATIONAL_SERVICES[m[1]];
    if (!service) continue; // coaches, on-demand shuttles…
    pointToArea.set(r.stop_id, r.parent_station);
    pointService.set(r.stop_id, service);
  }

  const routes = new Map();
  for (const r of readTable(zip, 'routes.txt', ['route_id', 'route_short_name', 'route_long_name'])) {
    const short = r.route_short_name && r.route_short_name !== 'INCONNU' ? r.route_short_name : '';
    routes.set(r.route_id, [short, r.route_long_name].filter(Boolean).join(' · '));
  }
  const active = activeServices(zip, date);
  const trips = new Map();
  for (const r of readTable(zip, 'trips.txt', ['trip_id', 'route_id', 'service_id'])) {
    trips.set(r.trip_id, { line: routes.get(r.route_id) ?? '', active: active.has(r.service_id) });
  }

  for (const r of readTable(zip, 'stop_times.txt', ['trip_id', 'stop_id', 'pickup_type'])) {
    const area = pointToArea.get(r.stop_id);
    if (!area) continue;
    const station = stations.get(area);
    const trip = trips.get(r.trip_id);
    station.services.add(pointService.get(r.stop_id));
    if (trip?.line) addLine(station, trip.line);
    if (trip?.active && r.pickup_type !== '1') station.departures++;
  }
  return [...stations.values()].filter((s) => s.services.size > 0);
}

function buildTransilien(zip, date) {
  const areas = new Map();
  const pointToArea = new Map();
  const rows = [...readTable(zip, 'stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station'])];
  for (const r of rows) {
    if (r.location_type === '1') {
      areas.set(r.stop_id, {
        id: r.stop_id.replace('IDFM:', 'idfm-'),
        name: prettyName(r.stop_name),
        coord: [round(+r.stop_lon), round(+r.stop_lat)],
        services: new Set(),
        lineCounts: new Map(),
        departures: 0,
      });
    }
  }
  for (const r of rows) if (r.location_type === '0' && areas.has(r.parent_station)) pointToArea.set(r.stop_id, r.parent_station);

  const routes = new Map();
  for (const r of readTable(zip, 'routes.txt', ['route_id', 'agency_id', 'route_short_name', 'route_type'])) {
    const service = TRANSILIEN_AGENCIES[r.agency_id];
    // route_type 2 = rail; the feed also carries replacement buses.
    if (!service || r.route_type !== '2') continue;
    routes.set(r.route_id, { service, line: service === 'rer' ? `RER ${r.route_short_name}` : `Ligne ${r.route_short_name}` });
  }
  const active = activeServices(zip, date);
  const trips = new Map();
  for (const r of readTable(zip, 'trips.txt', ['trip_id', 'route_id', 'service_id'])) {
    const route = routes.get(r.route_id);
    if (route) trips.set(r.trip_id, { ...route, active: active.has(r.service_id) });
  }
  for (const r of readTable(zip, 'stop_times.txt', ['trip_id', 'stop_id', 'pickup_type'])) {
    const trip = trips.get(r.trip_id);
    const area = trip && pointToArea.get(r.stop_id);
    if (!area) continue;
    const station = areas.get(area);
    station.services.add(trip.service);
    addLine(station, trip.line);
    if (trip.active && r.pickup_type !== '1') station.departures++;
  }
  return [...areas.values()].filter((s) => s.services.size > 0);
}

/** Folds Transilien stations into the national ones when they are the same place. */
function merge(national, transilien) {
  const out = [...national];
  for (const t of transilien) {
    const tName = normaliseName(t.name);
    const match = national.find((n) => {
      const d = distanceM(n.coord, t.coord);
      if (d > 600) return false;
      const nName = normaliseName(n.name);
      return d < 150 || nName.includes(tName) || tName.includes(nName) || nName.split(' ')[0] === tName.split(' ')[0];
    });
    if (match) {
      t.services.forEach((s) => match.services.add(s));
      t.lineCounts.forEach((c, l) => match.lineCounts.set(l, (match.lineCounts.get(l) ?? 0) + c));
      match.departures += t.departures;
    } else {
      out.push(t);
    }
  }
  return out;
}

const SERVICE_ORDER = ['tgv', 'ouigo', 'intl', 'ic', 'icn', 'ter', 'tramtrain', 'rer', 'transilien'];

async function main() {
  const date = representativeDate();
  console.log(`Gares — journée de référence : ${date}`);
  const national = buildNational(openZip(await downloadCached(NATIONAL_URL, 'sncf-gtfs.zip')), date);
  console.log(`  ${national.length} gares SNCF (hors Transilien)`);
  const transilien = buildTransilien(openZip(await downloadCached(TRANSILIEN_URL, 'transilien-gtfs.zip')), date);
  console.log(`  ${transilien.length} gares Transilien / RER`);
  const stations = merge(national, transilien);

  const features = stations
    .sort((a, b) => b.departures - a.departures)
    .map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: s.coord },
      properties: {
        id: s.id,
        name: s.name,
        services: SERVICE_ORDER.filter((k) => s.services.has(k)).join(','),
        lines: [...s.lineCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l]) => l).join('|'),
        departures: s.departures,
      },
    }));

  await mkdir('public/data', { recursive: true });
  const geojson = {
    type: 'FeatureCollection',
    metadata: { source: 'SNCF Open Data (GTFS), Licence ODbL', referenceDate: date, generated: new Date().toISOString() },
    features,
  };
  await writeFile(OUT, JSON.stringify(geojson));
  console.log(`✓ ${features.length} gares → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
