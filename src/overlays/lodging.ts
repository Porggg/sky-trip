// Accommodation from OpenStreetMap (campsites, hotels, B&Bs, gîtes, hostels, huts),
// loaded on demand for the visible area, with a pre-filled Booking.com search.
import type * as maplibregl from 'maplibre-gl';
import { SLOTS, addSvgImage } from '../map/createMap';
import { h } from '../lib/dom';
import { overpass, type OsmElement } from '../lib/overpass';
import { bookingSearchUrl } from '../lib/booking';
import { placeName } from '../lib/geocode';
import { glyph, iconEl, type IconName } from '../ui/icons';
import type { LngLat } from '../lib/geo';
import type { AppContext, Overlay } from './types';

type Category = 'camping' | 'hotel' | 'chambre' | 'gite' | 'hostel' | 'refuge';

const CATEGORIES: Record<Category, { label: string; glyph: IconName }> = {
  camping: { label: 'Campings', glyph: 'tent' },
  hotel: { label: 'Hôtels', glyph: 'bed' },
  chambre: { label: 'Chambres d’hôtes', glyph: 'house' },
  gite: { label: 'Gîtes', glyph: 'house' },
  hostel: { label: 'Auberges', glyph: 'bed' },
  refuge: { label: 'Refuges & abris', glyph: 'hut' },
};

const SINGULAR: Record<Category, string> = {
  camping: 'Camping',
  hotel: 'Hôtel',
  chambre: 'Chambre d’hôtes',
  gite: 'Gîte / location',
  hostel: 'Auberge, gîte d’étape',
  refuge: 'Refuge ou abri',
};

function categoryOf(tags: Record<string, string>): Category | null {
  switch (tags.tourism) {
    case 'camp_site':
      return 'camping';
    case 'hotel':
    case 'motel':
      return 'hotel';
    case 'guest_house':
      return 'chambre';
    case 'chalet':
    case 'apartment':
      return 'gite';
    case 'hostel':
      return 'hostel';
    case 'alpine_hut':
    case 'wilderness_hut':
      return 'refuge';
  }
  if (tags.amenity === 'shelter') return 'refuge';
  return null;
}

const MIN_ZOOM = 10;
const TILE_ZOOM = 10;
const MAX_TILES_PER_LOAD = 16;
const SOURCE = 'lodging';
const L = { clusters: 'lodging-clusters', count: 'lodging-count', points: 'lodging-points' };
const COLOR = '#8c2f55';

function pinIcon(g: IconName): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="56" viewBox="0 0 24 28">
    <path d="M12 27s-9.5-8.3-9.5-15.2a9.5 9.5 0 0 1 19 0C21.5 18.7 12 27 12 27z" fill="${COLOR}" stroke="#ffffff" stroke-width="1.4"/>
    <g transform="translate(6.2 5.6) scale(0.48)">${glyph(g, '#ffffff', 2.4)}</g>
  </svg>`;
}

function tileRange(bounds: maplibregl.LngLatBounds) {
  const n = 2 ** TILE_ZOOM;
  const x = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const y = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: x(bounds.getWest()), x1: x(bounds.getEast()), y0: y(bounds.getNorth()), y1: y(bounds.getSouth()) };
}

function tileBounds(x: number, y: number) {
  const n = 2 ** TILE_ZOOM;
  const lon = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return { w: lon(x), e: lon(x + 1), n: lat(y), s: lat(y + 1) };
}

export function lodgingOverlay(): Overlay {
  let ctx: AppContext;
  let visible = false;
  let statusHandler: (s: string) => void = () => {};
  const loadedTiles = new Set<string>();
  const features = new Map<string, GeoJSON.Feature<GeoJSON.Point>>();
  const enabled = new Set<Category>(Object.keys(CATEGORIES) as Category[]);
  let controller: AbortController | null = null;
  let loading = false;

  const setStatus = (s: string) => statusHandler(s);

  // Categories are filtered in the data rather than with a layer filter, so clusters
  // only count what is actually shown.
  const applyFilter = () => {
    (ctx.map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [...features.values()].filter((f) => enabled.has(f.properties!.cat)),
    });
  };

  const refreshStatus = () => {
    if (!visible) return setStatus('');
    if (ctx.map.getZoom() < MIN_ZOOM) return setStatus('Zoomez sur une région pour afficher les hébergements.');
    if (loading) return setStatus('Recherche des hébergements…');
    const b = ctx.map.getBounds();
    let count = 0;
    for (const f of features.values()) {
      const [lng, lat] = f.geometry.coordinates;
      if (enabled.has(f.properties!.cat) && b.contains([lng, lat])) count++;
    }
    setStatus(count ? `${count} hébergement${count > 1 ? 's' : ''} dans la zone affichée.` : 'Aucun hébergement référencé dans cette zone.');
  };

  const load = async () => {
    if (!visible || ctx.map.getZoom() < MIN_ZOOM) return refreshStatus();
    const r = tileRange(ctx.map.getBounds());
    const missing: [number, number][] = [];
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) if (!loadedTiles.has(`${x}/${y}`)) missing.push([x, y]);
    if (!missing.length) return refreshStatus();
    if (missing.length > MAX_TILES_PER_LOAD) return setStatus('Zoomez un peu plus pour charger les hébergements.');

    const bb = missing.map(([x, y]) => tileBounds(x, y));
    const s = Math.min(...bb.map((b) => b.s));
    const w = Math.min(...bb.map((b) => b.w));
    const n = Math.max(...bb.map((b) => b.n));
    const e = Math.max(...bb.map((b) => b.e));
    const box = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
    const query = `[out:json][timeout:25];
(
  nwr["tourism"~"^(camp_site|hotel|motel|guest_house|chalet|apartment|hostel|alpine_hut|wilderness_hut)$"](${box});
  nwr["amenity"="shelter"]["shelter_type"~"^(basic_hut|lean_to)$"](${box});
);
out center tags qt;`;

    controller?.abort();
    controller = new AbortController();
    loading = true;
    refreshStatus();
    try {
      const elements = await overpass(query, controller.signal);
      for (const el of elements) addElement(el);
      missing.forEach(([x, y]) => loadedTiles.add(`${x}/${y}`));
      applyFilter();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setStatus('Les serveurs OpenStreetMap sont saturés. Réessayez dans un instant.');
      loading = false;
      return;
    }
    loading = false;
    refreshStatus();
  };

  const addElement = (el: OsmElement) => {
    const tags = el.tags ?? {};
    const cat = categoryOf(tags);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!cat || lat == null || lon == null) return;
    // Skip private or disused places.
    if (tags.access === 'private' || tags.disused === 'yes' || tags['abandoned'] === 'yes') return;
    const key = `${el.type}/${el.id}`;
    features.set(key, {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { key, cat, name: tags.name ?? '', tags: JSON.stringify(tags) },
    });
  };

  let moveTimer: number | undefined;
  const onMove = () => {
    window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => void load(), 350);
  };

  return {
    id: 'lodging',
    title: 'Hébergements',
    description: 'Campings, hôtels, chambres d’hôtes, gîtes et refuges référencés dans OpenStreetMap, avec un lien vers Booking.',
    icon: 'bed',
    slot: 'points',
    defaultVisible: false,
    interactiveLayers: [L.points, L.clusters],

    async init(c) {
      ctx = c;
      const map = ctx.map;
      await Promise.all(
        (Object.keys(CATEGORIES) as Category[]).map((cat) => addSvgImage(map, `lodging-${cat}`, pinIcon(CATEGORIES[cat].glyph), 24)),
      );
      map.addSource(SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 38,
      });
      map.addLayer(
        {
          id: L.clusters,
          type: 'circle',
          source: SOURCE,
          filter: ['has', 'point_count'],
          layout: { visibility: 'none' },
          paint: {
            'circle-color': COLOR,
            'circle-opacity': 0.92,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
            'circle-radius': ['step', ['get', 'point_count'], 13, 10, 16, 40, 20],
          },
        },
        SLOTS.points,
      );
      map.addLayer(
        {
          id: L.count,
          type: 'symbol',
          source: SOURCE,
          filter: ['has', 'point_count'],
          layout: {
            visibility: 'none',
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Noto Sans Medium'],
            'text-size': 12,
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#ffffff' },
        },
        SLOTS.points,
      );
      map.addLayer(
        {
          id: L.points,
          type: 'symbol',
          source: SOURCE,
          filter: ['!', ['has', 'point_count']],
          layout: {
            visibility: 'none',
            'icon-image': ['concat', 'lodging-', ['get', 'cat']],
            'icon-anchor': 'bottom',
            'icon-allow-overlap': true,
            'text-field': ['step', ['zoom'], '', 14, ['get', 'name']],
            'text-font': ['Noto Sans Medium'],
            'text-size': 11,
            'text-anchor': 'top',
            'text-offset': [0, 0.3],
            'text-optional': true,
            'text-max-width': 10,
          },
          paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.5 },
        },
        SLOTS.points,
      );
      map.on('moveend', onMove);
      for (const id of [L.points, L.clusters]) {
        map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
      }
    },

    setVisible(v) {
      visible = v;
      for (const id of Object.values(L)) ctx.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
      if (v) void load();
      else refreshStatus();
    },

    onStatus(handler) {
      statusHandler = handler;
    },

    popupFor(feature: maplibregl.MapGeoJSONFeature, lngLat: LngLat) {
      if (feature.properties?.point_count) {
        // Zoom into the cluster rather than showing a popup.
        const source = ctx.map.getSource(SOURCE) as maplibregl.GeoJSONSource;
        void source.getClusterExpansionZoom(feature.properties.cluster_id as number).then((zoom) => {
          ctx.map.easeTo({ center: lngLat, zoom: Math.min(zoom + 0.5, 16) });
        });
        return null;
      }
      const p = feature.properties as { cat: Category; name: string; tags: string };
      const tags = JSON.parse(p.tags) as Record<string, string>;
      const coord = (feature.geometry as GeoJSON.Point).coordinates as LngLat;
      const city = tags['addr:city'] ?? '';
      const address = [[tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '), [tags['addr:postcode'], city].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ');
      const facts: string[] = [];
      if (tags.stars) facts.push(`${tags.stars} étoile${Number(tags.stars) > 1 ? 's' : ''}`);
      if (tags.backcountry === 'yes' || tags.camp_site === 'basic') facts.push('Aire naturelle / bivouac');
      if (tags.tents === 'yes') facts.push('Tentes acceptées');
      if (tags.capacity) facts.push(`${tags.capacity} places`);
      if (tags.fee === 'no') facts.push('Gratuit');
      if (tags.opening_hours) facts.push(`Ouverture : ${tags.opening_hours}`);
      const website = tags.website ?? tags['contact:website'] ?? tags.url;
      const phone = tags.phone ?? tags['contact:phone'];
      const name = p.name || SINGULAR[p.cat];
      const bookingFor = (town: string) => bookingSearchUrl(p.name ? `${p.name} ${town}`.trim() : town || name, ctx.trip.settings.startDate);
      const booking = h('a', { class: 'btn btn--sm', href: bookingFor(city), target: '_blank', rel: 'noopener' }, 'Voir sur Booking', iconEl('external', 13));
      // Without an address, add the nearest town so Booking finds the right place.
      if (!city) placeName(coord).then((town) => town && (booking.href = bookingFor(town)));

      return h(
        'div',
        { class: 'popup-card' },
        h('div', { class: 'popup-card__eyebrow' }, iconEl(CATEGORIES[p.cat].glyph, 14), SINGULAR[p.cat]),
        h('h3', { class: 'popup-card__title' }, name),
        address ? h('p', { class: 'popup-card__meta' }, address) : null,
        facts.length ? h('ul', { class: 'facts' }, facts.map((f) => h('li', null, f))) : null,
        h(
          'div',
          { class: 'btn-row' },
          booking,
          website ? h('a', { class: 'btn btn--sm btn--ghost', href: website, target: '_blank', rel: 'noopener' }, 'Site web') : null,
          phone ? h('a', { class: 'btn btn--sm btn--ghost', href: `tel:${phone.replace(/\s/g, '')}` }, 'Appeler') : null,
        ),
        ctx.placeActions(coord, { name, kind: 'lodging' }),
      );
    },

    renderControls() {
      const chips = h(
        'div',
        { class: 'chips' },
        (Object.keys(CATEGORIES) as Category[]).map((cat) => {
          const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true' }, CATEGORIES[cat].label);
          chip.addEventListener('click', () => {
            if (enabled.has(cat)) enabled.delete(cat);
            else enabled.add(cat);
            chip.setAttribute('aria-pressed', String(enabled.has(cat)));
            applyFilter();
            refreshStatus();
          });
          return chip;
        }),
      );
      return h(
        'div',
        { class: 'overlay-controls' },
        chips,
        h(
          'p',
          { class: 'hint' },
          'Booking ne propose pas d’accès libre à ses données : chaque fiche ouvre une recherche Booking pré-remplie pour la date de la nuit.',
        ),
      );
    },
  };
}
