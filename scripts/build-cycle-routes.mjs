// Builds the cycle network layer from OpenStreetMap (via the Overpass API):
//   public/tiles/cycle/{z}/{x}/{y}.pbf  — vector tiles (layer "cycle"), so browsers only
//                                          load the area on screen
//   public/data/cycle-routes-index.json — one entry per route, for the searchable list
//
// Covers EuroVelo (icn), the French national scheme — V1, V2… (ncn), regional (rcn) and
// local (lcn, or no network tag) routes, plus named greenways that belong to no route
// ("Voie verte de …"), i.e. the network AF3V lists. Each segment is classified as
// greenway (car-free: cycleway, path, towpath…) or shared road, like the AF3V map.
//
// Usage: npm run data:cycle-routes   (add --refresh to re-download)
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';

const OUT_TILES = 'public/tiles/cycle';
const TILE_MIN_ZOOM = 4;
const TILE_MAX_ZOOM = 11;
const OUT_INDEX = 'public/data/cycle-routes-index.json';
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const FR = 'area["ISO3166-1"="FR"][admin_level=2]->.fr;';
const QUERIES = {
  // EuroVelo, national and regional routes.
  routes: `[out:json][timeout:900];${FR}
rel(area.fr)[type=route][route=bicycle][network~"^(icn|ncn|rcn)$"]->.r;
.r out body;
way(r.r);
out tags geom;`,
  // Local routes and routes without a network tag.
  local: `[out:json][timeout:900];${FR}
rel(area.fr)[type=route][route=bicycle][network!~"^(icn|ncn|rcn)$"]->.r;
.r out body;
way(r.r);
out tags geom;`,
  // Named greenways, whether or not they belong to a route.
  named: `[out:json][timeout:600];${FR}
way(area.fr)[highway~"^(cycleway|path|track|footway|bridleway|pedestrian)$"][name~"voie verte|coul[ée]e verte|v[ée]loroute|halage|v[ée]lo ?voie|piste cyclable",i];
out tags geom;`,
};

// Mainland France + Corsica, with a margin so cross-border links stay visible.
const BOUNDS = [-5.9, 41.2, 10.2, 51.35];
const SIMPLIFY_TOLERANCE = 0.00003; // degrees, ≈ 3 m — tiling simplifies further per zoom
// "lcn" also stands for routes without a network tag; "vv" is a named greenway outside any route.
const NETWORK_RANK = { icn: 3, ncn: 2, rcn: 1, lcn: 0, vv: 0 };
const GREENWAY_NAME = /voie verte|coul[ée]e verte|v[ée]loroute|halage|v[ée]lo ?voie/i;
// Names too vague to stand alone in the catalogue (still drawn on the map).
// Street names that merely mention a greenway ("Rue de la Voie Verte").
const STREET_NAME = /^(rue|avenue|all[ée]e|impasse|place|boulevard|square|quai|sentier|route|cours)\b/i;
const GENERIC_NAME = /^(chemin de )?(la |le |l')?(ancien(ne)? )?(voie verte|coul[ée]e verte|v[ée]loroute|v[ée]lo ?voie|(chemin (de |du )?)?(contre[- ]?)?halage)$/i;

async function fetchOverpass(name) {
  const CACHE = `.cache/overpass-${name}.json`;
  const QUERY = QUERIES[name];
  const refresh = process.argv.includes('--refresh');
  if (!refresh) {
    try {
      const s = await stat(CACHE);
      if (s.size > 1e4) return JSON.parse(await readFile(CACHE, 'utf8'));
    } catch {
      // no cache yet
    }
  }
  console.log(`  requête « ${name} »`);
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of MIRRORS) {
      console.log(`  ↓ ${url}`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-trip-data-build/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: QUERY }),
        });
        if (!res.ok) {
          console.log(`    HTTP ${res.status}`);
          continue;
        }
        const text = await res.text();
        await mkdir('.cache', { recursive: true });
        await writeFile(CACHE, text);
        return JSON.parse(text);
      } catch (err) {
        console.log(`    ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error('Overpass indisponible, réessayez plus tard.');
}

function classify(tags) {
  const hw = tags.highway ?? '';
  const motorFree = /^(no|private|agricultural|forestry|agricultural;forestry)$/.test(tags.motor_vehicle ?? tags.access ?? '');
  const greenway =
    ['cycleway', 'path', 'footway', 'pedestrian', 'bridleway'].includes(hw) ||
    (hw === 'track' && (motorFree || tags.bicycle === 'designated')) ||
    tags.bicycle_road === 'yes' ||
    tags.cyclestreet === 'yes' ||
    /^(track|separate)$/.test(tags['cycleway:both'] ?? tags['cycleway:right'] ?? tags.cycleway ?? '');
  const unpaved =
    /^(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|mud|sand|pebblestone|woodchips|rock)$/.test(tags.surface ?? '') ||
    /^grade[3-5]$/.test(tags.tracktype ?? '');
  return { greenway, unpaved };
}

function inBounds([lon, lat]) {
  return lon >= BOUNDS[0] && lon <= BOUNDS[2] && lat >= BOUNDS[1] && lat <= BOUNDS[3];
}

// Douglas–Peucker on planar lon/lat (fine at this tolerance).
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function lengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const kx = 111320 * Math.cos(((y1 + y2) / 2) * (Math.PI / 180));
    total += Math.hypot((x2 - x1) * kx, (y2 - y1) * 110540);
  }
  return total;
}

/** Joins lines that share endpoints and carry the same properties. */
function mergeLines(lines) {
  const key = (p) => `${p[0]},${p[1]}`;
  const byEnd = new Map();
  const add = (i, p) => {
    const k = key(p);
    if (!byEnd.has(k)) byEnd.set(k, []);
    byEnd.get(k).push(i);
  };
  lines.forEach((l, i) => {
    add(i, l[0]);
    add(i, l[l.length - 1]);
  });
  const used = new Uint8Array(lines.length);
  const out = [];
  const take = (p) => {
    const candidates = byEnd.get(key(p)) ?? [];
    const i = candidates.find((c) => !used[c]);
    if (i === undefined) return null;
    used[i] = 1;
    const l = lines[i];
    return key(l[0]) === key(p) ? l : [...l].reverse();
  };
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let line = [...lines[i]];
    for (let next; (next = take(line[line.length - 1])); ) line = line.concat(next.slice(1));
    for (let prev; (prev = take(line[0])); ) line = [...prev].reverse().slice(0, -1).concat(line);
    out.push(line);
  }
  return out;
}

const round = (n) => Math.round(n * 1e5) / 1e5;

// French names of the EuroVelo routes as signposted in France.
const EUROVELO_FR = {
  EV1: 'La Vélodyssée',
  EV3: 'La Scandibérique',
  EV4: 'La Vélomaritime',
  EV5: 'Via Romea Francigena',
  EV6: 'EuroVelo 6 — Véloroute des fleuves',
  EV8: 'La Méditerranée à vélo',
  EV15: 'Véloroute du Rhin',
  EV17: 'ViaRhôna',
  EV19: 'La Meuse à vélo',
  EV12: 'Véloroute de la mer du Nord',
};

/** "La Voie Bleue, Moselle-Saône à vélo - Golbey > Port-sur-Saône" → "La Voie Bleue". */
function baseName(name, ref) {
  let n = name.trim();
  // Strip a leading route code ("V65 - …", "EV8 France 11, …") but not a word ("Mosel-Radweg").
  if (ref && /\d/.test(ref) && n.toUpperCase().startsWith(ref.toUpperCase())) n = n.slice(ref.length).replace(/^[\s:–—-]+/, '');
  n = n.split(/\s[:–—-]\s|:\s|,\s|\s\(|\s\/\s|\s>\s|\s\|\s/)[0];
  n = n.replace(/\s+(\d+(\/\d+)?|tronçon.*|étape.*|partie.*|section.*)$/i, '').trim();
  return n;
}

function groupRoutes(relations) {
  const groups = new Map();
  for (const rel of relations.values()) {
    const t = rel.tags;
    const ref = (t.ref ?? '').trim();
    const name = (t['name:fr'] ?? t.name ?? '').trim();
    if (!ref && !name) continue;
    const network = NETWORK_RANK[t.network] > 0 ? t.network : 'lcn';
    // National codes (V41, EV6) identify an itinerary; local loop numbers ("23") repeat
    // all over France, so those routes are grouped by name instead — the full name for
    // local loops, whose names differ only by a number ("Boucle 3", "Boucle 12").
    const codeRef = /^[A-Za-z]{1,4}\s?\d/.test(ref) && network !== 'lcn';
    const byName = network === 'lcn' ? name : baseName(name || ref, ref);
    const key = `${network}|${codeRef ? ref : byName || ref}`;
    if (!groups.has(key)) groups.set(key, { network, ref, rels: [], ways: [], website: null });
    const g = groups.get(key);
    g.rels.push(rel.id);
    if (!g.website && t.website) g.website = t.website;
    // A bare "Boucle 3" means nothing out of its local context.
    if (network === 'lcn' && /^(boucle|circuit|itin[ée]raire|parcours|balade)\s*(n°|no)?\s*\d*$/i.test(name || ref)) g.generic = true;
    g.nameCandidates ??= [];
    // Longer sections weigh more when picking the itinerary's common name.
    g.nameCandidates.push({ name, weight: rel.members?.length ?? 1 });
  }
  return [...groups.values()];
}

/**
 * Named greenways that belong to no route: ways with the same name that touch or lie
 * within ~3 km of each other form one itinerary.
 */
function groupOrphanGreenways(named, taken) {
  const byName = new Map();
  for (const w of named) {
    const name = (w.tags?.name ?? '').trim();
    if (taken.has(w.id) || !w.geometry || !GREENWAY_NAME.test(name) || STREET_NAME.test(name)) continue;
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(w);
  }
  const groups = [];
  const CELL = 0.03;
  for (const list of byName.values()) {
    const parent = list.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const cells = new Map();
    list.forEach((w, i) => {
      for (const g of [w.geometry[0], w.geometry[w.geometry.length - 1]]) {
        const cx = Math.floor(g.lon / CELL);
        const cy = Math.floor(g.lat / CELL);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) {
            const k = `${cx + dx},${cy + dy}`;
            if (cells.has(k)) parent[find(i)] = find(cells.get(k));
          }
        cells.set(`${cx},${cy}`, i);
      }
    });
    const clusters = new Map();
    list.forEach((w, i) => {
      const r = find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r).push(w);
    });
    for (const ways of clusters.values()) {
      const name = ways[0].tags.name.trim();
      groups.push({ network: 'vv', ref: '', rels: [], ways: ways.map((w) => w.id), website: null, generic: GENERIC_NAME.test(name), nameCandidates: [{ name, weight: 1 }] });
    }
  }
  return groups;
}

async function writeTiles(features) {
  await rm(OUT_TILES, { recursive: true, force: true });
  const index = new GeoJSONVT({ type: 'FeatureCollection', features }, { maxZoom: TILE_MAX_ZOOM, indexMaxZoom: 6, tolerance: 1.5, extent: 4096, buffer: 64 });
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  let count = 0;
  let bytes = 0;
  for (let z = TILE_MIN_ZOOM; z <= TILE_MAX_ZOOM; z++) {
    for (let x = lon2x(BOUNDS[0], z); x <= lon2x(BOUNDS[2], z); x++) {
      for (let y = lat2y(BOUNDS[3], z); y <= lat2y(BOUNDS[1], z); y++) {
        const tile = index.getTile(z, x, y);
        if (!tile || !tile.features.length) continue;
        const pbf = fromGeojsonVt({ cycle: tile }, { version: 2, extent: 4096 });
        await mkdir(`${OUT_TILES}/${z}/${x}`, { recursive: true });
        await writeFile(`${OUT_TILES}/${z}/${x}/${y}.pbf`, pbf);
        count++;
        bytes += pbf.length;
      }
    }
  }
  return { count, bytes };
}

async function main() {
  console.log('Véloroutes — lecture des données OpenStreetMap');
  const data = await fetchOverpass('routes');
  const local = await fetchOverpass('local');
  const named = await fetchOverpass('named');
  const relations = new Map();
  const ways = new Map();
  for (const el of [...data.elements, ...local.elements]) {
    if (el.type === 'relation') relations.set(el.id, el);
    else if (el.type === 'way' && el.geometry) ways.set(el.id, el);
  }

  // Keep routes that exist on the ground.
  for (const [id, rel] of relations) {
    const state = rel.tags?.state ?? '';
    if (/proposed|construction|planned|disused/.test(state) || rel.tags?.['disused:route']) relations.delete(id);
  }

  // Sections of the same itinerary (EV6 France 01, 02…) become one entry.
  const groups = groupRoutes(relations);
  const relGroup = new Map();
  groups.forEach((g, i) => g.rels.forEach((r) => relGroup.set(r, i)));

  const wayGroups = new Map();
  const addWay = (wayId, gi) => {
    if (!wayGroups.has(wayId)) wayGroups.set(wayId, new Set());
    wayGroups.get(wayId).add(gi);
  };
  for (const rel of relations.values()) {
    const gi = relGroup.get(rel.id);
    if (gi === undefined) continue;
    for (const m of rel.members ?? []) {
      if (m.type === 'way' && ways.has(m.ref)) addWay(m.ref, gi);
    }
  }

  // Other names a route is known by (section names, named greenways along it) for search.
  const aliases = groups.map((g) => new Set(g.nameCandidates?.map((c) => c.name).filter(Boolean) ?? []));
  const isGreenwayName = (n) => n && GREENWAY_NAME.test(n) && !GENERIC_NAME.test(n) && !STREET_NAME.test(n);
  const aliasBoxes = new Map(); // greenway name → [{ gi, bbox }]
  for (const [wayId, gset] of wayGroups) {
    const n = ways.get(wayId)?.tags?.name?.trim();
    if (!isGreenwayName(n)) continue;
    for (const gi of gset) {
      aliases[gi].add(n);
      const key = n.toLowerCase();
      if (!aliasBoxes.has(key)) aliasBoxes.set(key, []);
      aliasBoxes.get(key).push({ gi, geometry: ways.get(wayId).geometry });
    }
  }

  // Greenways outside any route become their own entries — unless the same greenway,
  // nearby, already belongs to a route (then the missing pieces join that route).
  const namedWays = named.elements.filter((e) => e.type === 'way' && e.geometry);
  const namedById = new Map(namedWays.map((w) => [w.id, w]));
  const near = (a, b) => a.some((p) => b.some((q) => Math.abs(p.lat - q.lat) < 0.03 && Math.abs(p.lon - q.lon) < 0.04));
  let joined = 0;
  for (const g of groupOrphanGreenways(namedWays, wayGroups)) {
    const clusterGeom = g.ways.flatMap((id) => namedById.get(id).geometry);
    const host = aliasBoxes.get(g.nameCandidates[0].name.toLowerCase())?.find((c) => near(clusterGeom, c.geometry));
    let gi;
    if (host) {
      gi = host.gi;
      joined++;
    } else {
      gi = groups.push(g) - 1;
      aliases.push(new Set());
    }
    for (const id of g.ways) {
      ways.set(id, namedById.get(id));
      addWay(id, gi);
    }
  }
  console.log(`  ${joined} voies vertes rattachées à un itinéraire existant`);

  // Group way geometries by identical display properties, then merge them.
  const lineGroups = new Map();
  const stats = groups.map(() => ({ length: 0, greenway: 0, bbox: [180, 90, -180, -90] }));
  for (const [wayId, gset] of wayGroups) {
    const way = ways.get(wayId);
    const points = way.geometry.map((g) => [g.lon, g.lat]);
    if (!points.some(inBounds)) continue;
    const { greenway, unpaved } = classify(way.tags ?? {});
    const gs = [...gset].sort((a, b) => a - b);
    const net = Math.max(...gs.map((g) => NETWORK_RANK[groups[g].network] ?? 1));
    const k = `${net}|${greenway ? 1 : 0}|${unpaved ? 1 : 0}|${gs.join(',')}`;
    if (!lineGroups.has(k)) lineGroups.set(k, { net, greenway, unpaved, gs, lines: [] });
    lineGroups.get(k).lines.push(points);

    const len = lengthM(points);
    for (const g of gs) {
      const st = stats[g];
      st.length += len;
      if (greenway) st.greenway += len;
      for (const [x, y] of points) {
        st.bbox[0] = Math.min(st.bbox[0], x);
        st.bbox[1] = Math.min(st.bbox[1], y);
        st.bbox[2] = Math.max(st.bbox[2], x);
        st.bbox[3] = Math.max(st.bbox[3], y);
      }
    }
  }

  const features = [];
  for (const lg of lineGroups.values()) {
    for (const line of mergeLines(lg.lines)) {
      const simplified = simplify(line, SIMPLIFY_TOLERANCE).map(([x, y]) => [round(x), round(y)]);
      if (simplified.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: simplified },
        properties: {
          net: lg.net,
          green: lg.greenway ? 1 : 0,
          unpaved: lg.unpaved ? 1 : 0,
          // Comma-wrapped route indexes, so the map can filter with a substring test.
          g: `,${lg.gs.join(',')},`,
          // Signposted code shown along the line (EV6, V46…), highest network first.
          ref: lg.gs
            .map((g) => groups[g])
            .filter((g) => /\d/.test(g.ref) && NETWORK_RANK[g.network] >= 2)
            .sort((a, b) => NETWORK_RANK[b.network] - NETWORK_RANK[a.network])
            .map((g) => g.ref)
            .filter((r, i, all) => all.indexOf(r) === i)
            .slice(0, 2)
            .join(' · '),
        },
      });
    }
  }

  const index = groups
    .map((g, i) => {
      const st = stats[i];
      if (!st.length) return null;
      const counts = new Map();
      g.nameCandidates.forEach(({ name, weight }) => {
        const b = g.network === 'lcn' ? name : baseName(name, g.ref);
        if (b) counts.set(b, (counts.get(b) ?? 0) + weight);
      });
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const name = EUROVELO_FR[g.ref] || best || g.nameCandidates[0]?.name || g.ref;
      const aka = [...aliases[i]].filter((a) => a !== name && baseName(a, g.ref) !== name).slice(0, 8);
      return {
        i,
        ref: g.ref && g.ref !== name ? g.ref : '',
        name,
        network: g.network,
        km: Math.round(st.length / 1000),
        greenway: Math.round((st.greenway / st.length) * 100) / 100,
        bbox: st.bbox.map(round),
        ...(g.website ? { website: g.website } : {}),
        ...(aka.length ? { aka } : {}),
        ...(g.generic || (NETWORK_RANK[g.network] === 0 && GENERIC_NAME.test(name)) ? { generic: 1 } : {}),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (NETWORK_RANK[b.network] ?? 0) - (NETWORK_RANK[a.network] ?? 0) || b.km - a.km);

  await mkdir('public/data', { recursive: true });
  await writeFile(
    OUT_INDEX,
    JSON.stringify({ source: '© contributeurs OpenStreetMap, ODbL', osmTimestamp: data.osm3s?.timestamp_osm_base, routes: index }),
  );
  const tiles = await writeTiles(features);
  console.log(`✓ ${index.length} itinéraires, ${features.length} tronçons`);
  console.log(`  → ${OUT_INDEX}`);
  console.log(`  → ${OUT_TILES}: ${tiles.count} tuiles, ${(tiles.bytes / 1e6).toFixed(1)} Mo`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
