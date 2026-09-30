// MapLibre's stylesheet first, so our map.css overrides it.
import 'maplibre-gl/dist/maplibre-gl.css';
import '@fontsource-variable/fraunces';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/features.css';
import './styles/map.css';

import * as maplibregl from 'maplibre-gl';
import { createMap, setBasemap, type BasemapId } from './map/createMap';
import { RouteLayer } from './map/routeLayer';
import { createOverlays, OverlayManager } from './overlays';
import { fitPadding } from './overlays/cycleRoutes';
import type { AppContext } from './overlays/types';
import { Trip, type Waypoint } from './route/trip';
import { persist, restore } from './route/share';
import { bbox, type LngLat } from './lib/geo';
import { h, svg } from './lib/dom';
import { placeName } from './lib/geocode';
import { bookingSearchUrl } from './lib/booking';
import { skyAt } from './sky/lightAtlas';
import { Panel } from './ui/panel';
import { createSearch } from './ui/search';
import { createTripPanel } from './ui/tripPanel';
import { createLayersPanel } from './ui/layersPanel';
import { createRoutesCatalog } from './ui/routesCatalog';
import { icon } from './ui/icons';

const BASEMAP_KEY = 'sky-trip:basemap';

function readBasemap(): BasemapId {
  try {
    const v = localStorage.getItem(BASEMAP_KEY);
    return v === 'nuit' || v === 'velo' ? v : 'plan';
  } catch {
    return 'plan';
  }
}

// ——— Shell ———

const app = document.getElementById('app')!;
const mapEl = h('div', { class: 'map', id: 'map', role: 'region', 'aria-label': 'Carte interactive' });
const indicatorText = h('span', null, 'Calcul de l’itinéraire…');
const indicatorCancel = h('button', { class: 'routing-indicator__cancel', type: 'button', hidden: true }, 'Annuler');
const indicator = h('div', { class: 'routing-indicator', role: 'status' }, h('span', { class: 'spinner' }), indicatorText, indicatorCancel);
const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
app.append(mapEl, indicator, toastEl);

let toastTimer: number | undefined;
function toast(message: string) {
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('is-visible'), 2800);
}

const panel = new Panel(app);
const map = createMap(mapEl);
if (import.meta.env.DEV) Object.assign(window, { __map: map });
const trip = new Trip();
const { list: overlayList, cycleRoutes } = createOverlays();
const overlays = new OverlayManager(overlayList);

let basemap = readBasemap();
const basemapHandlers: ((id: BasemapId) => void)[] = [];

// ——— Popups ———

// Closing on map click is handled in our own click handler, so a click can swap popups.
const popup = new maplibregl.Popup({ className: 'st-popup', maxWidth: '340px', focusAfterOpen: false, offset: 14, closeOnClick: false });

function openPopup(lngLat: LngLat, content: HTMLElement) {
  popup.setLngLat(lngLat).setDOMContent(content).addTo(map);
}

function placeActions(lngLat: LngLat, meta: Partial<Waypoint>): HTMLElement {
  const n = trip.waypoints.length;
  const act = (fn: () => void, message: string) => () => {
    fn();
    popup.remove();
    toast(message);
    panel.select('trip');
    panel.reveal('peek');
  };
  const start = h('button', { class: `btn btn--sm${n === 0 ? ' btn--primary' : ''}`, type: 'button' }, svg(icon('flag', 14)), n >= 2 ? 'Nouveau départ' : 'Départ');
  const via = h('button', { class: `btn btn--sm${n >= 2 ? ' btn--primary' : ''}`, type: 'button' }, svg(icon('plus', 14)), 'Étape');
  const end = h('button', { class: `btn btn--sm${n === 1 ? ' btn--primary' : ''}`, type: 'button' }, svg(icon('pin', 14)), n >= 2 ? 'Nouvelle arrivée' : 'Arrivée');
  start.addEventListener('click', act(() => trip.setStart(lngLat, meta), 'Départ ajouté.'));
  via.addEventListener('click', act(() => trip.addVia(lngLat, meta), 'Étape ajoutée au parcours.'));
  end.addEventListener('click', act(() => trip.setEnd(lngLat, meta), n === 0 ? 'Point ajouté.' : 'Arrivée ajoutée.'));
  const buttons = n < 2 ? [start, end] : [via, start, end];
  return h('div', { class: 'place-actions' }, buttons);
}

/** Popup for an empty spot of the map: place name, sky quality and trip actions. */
function pointPopup(lngLat: LngLat, knownName?: string) {
  const title = h('h3', { class: 'popup-card__title' }, knownName ?? 'Point sur la carte');
  const skyEl = h('div', { class: 'sky-reading' }, h('span', { class: 'hint' }, 'Qualité du ciel…'));
  const bookingLink = h('a', { class: 'popup-card__link', target: '_blank', rel: 'noopener', hidden: true }, 'Hébergements autour sur Booking', svg(icon('external', 13)));
  const meta: Partial<Waypoint> = { kind: 'place', name: knownName };
  openPopup(
    lngLat,
    h(
      'div',
      { class: 'popup-card' },
      h('div', { class: 'popup-card__eyebrow' }, svg(icon('pin', 14)), h('span', { class: 'num' }, `${lngLat[1].toFixed(4)}, ${lngLat[0].toFixed(4)}`)),
      title,
      skyEl,
      placeActions(lngLat, meta),
      bookingLink,
    ),
  );
  placeName(lngLat).then((name) => {
    if (!name) return;
    if (!knownName) {
      title.textContent = name;
      meta.name = name;
    }
    bookingLink.href = bookingSearchUrl(name, trip.settings.startDate);
    bookingLink.hidden = false;
  });
  skyAt(lngLat[0], lngLat[1]).then((sky) => {
    if (!sky) {
      skyEl.replaceChildren(h('span', { class: 'hint' }, 'Qualité du ciel indisponible ici.'));
      return;
    }
    skyEl.replaceChildren(
      h('span', { class: 'zone-swatch zone-swatch--lg', style: `background:${sky.zone.color}` }),
      h(
        'span',
        null,
        h('strong', null, `Ciel ${sky.zone.label.toLowerCase()}`),
        h('span', { class: 'sky-reading__sub' }, h('span', { class: 'num' }, `${sky.sqm.toFixed(2).replace('.', ',')} mag/″²`), ` · Voie lactée ${sky.milkyWay}`),
      ),
    );
  });
}

// ——— Camera helpers ———

function fitRoute() {
  const go = () => {
    const coords = trip.route?.coords ?? trip.waypoints.map((w) => w.lngLat);
    if (!coords.length) return;
    const [w, s, e, n] = bbox(coords);
    map.fitBounds([w, s, e, n], { padding: fitPadding(), maxZoom: 13, duration: 900 });
  };
  go();
  // Refine once the route being computed arrives.
  if (trip.pending) {
    const off = trip.on('route', () => {
      off();
      go();
    });
  }
}

function focus(lngLat: LngLat, zoom = 12) {
  map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), zoom), padding: fitPadding(), duration: 900 });
}

// ——— Map tools ———

const layersTool = h('button', { class: 'tool', type: 'button', 'aria-label': 'Calques' }, svg(icon('layers', 19)));
layersTool.addEventListener('click', () => {
  panel.select('layers');
  panel.reveal('half');
});
const zoomIn = h('button', { class: 'tool', type: 'button', 'aria-label': 'Zoomer' }, svg(icon('plus', 19)));
const zoomOut = h('button', { class: 'tool', type: 'button', 'aria-label': 'Dézoomer' }, svg(icon('minus', 19)));
zoomIn.addEventListener('click', () => map.zoomIn());
zoomOut.addEventListener('click', () => map.zoomOut());
const locateTool = h('button', { class: 'tool', type: 'button', 'aria-label': 'Me localiser' }, svg(icon('locate', 19)));
let youMarker: maplibregl.Marker | null = null;
locateTool.addEventListener('click', () => {
  if (!navigator.geolocation) return toast('La géolocalisation n’est pas disponible.');
  locateTool.setAttribute('aria-pressed', 'true');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
      youMarker ??= new maplibregl.Marker({ element: h('div', { class: 'you-marker' }) });
      youMarker.setLngLat(p).addTo(map);
      focus(p, 12);
      locateTool.setAttribute('aria-pressed', 'false');
    },
    () => {
      toast('Position introuvable. Autorisez la localisation dans le navigateur.');
      locateTool.setAttribute('aria-pressed', 'false');
    },
    { enableHighAccuracy: false, timeout: 10000 },
  );
});
app.append(
  h(
    'div',
    { class: 'map-tools' },
    h('div', { class: 'tool-group tool-group--mobile' }, layersTool),
    h('div', { class: 'tool-group' }, zoomIn, zoomOut),
    h('div', { class: 'tool-group' }, locateTool),
  ),
);

// ——— Panel contents ———

panel.head.append(
  createSearch(
    (place) => {
      map.flyTo({ center: place.lngLat, zoom: Math.max(11, Math.min(map.getZoom() + 2, 13)), padding: fitPadding(), duration: 1000 });
      map.once('moveend', () => pointPopup(place.lngLat, place.name));
    },
    () => {
      const c = map.getCenter();
      return [c.lng, c.lat];
    },
  ),
);

let routeLayer: RouteLayer | null = null;
const tripPanel = createTripPanel(panel.body('trip'), {
  trip,
  onHover: (p) => routeLayer?.showHover(p),
  onStages: (stages) => routeLayer?.setNights(stages),
  fitRoute,
  focus,
  toast,
  showLodgingAround(lngLat) {
    overlays.setVisible('lodging', true);
    map.flyTo({ center: lngLat, zoom: 12.5, padding: fitPadding(), duration: 1000 });
    panel.collapse();
    toast('Hébergements affichés autour de l’étape.');
  },
});

createLayersPanel(panel.body('layers'), overlays, {
  get: () => basemap,
  set(id) {
    basemap = id;
    setBasemap(map, id);
    basemapHandlers.forEach((fn) => fn(id));
    try {
      localStorage.setItem(BASEMAP_KEY, id);
    } catch {
      // ignore
    }
  },
});

createRoutesCatalog(
  panel.body('routes'),
  cycleRoutes,
  () => panel.collapse(),
  (n) => panel.setCount('routes', n),
);

indicatorCancel.addEventListener('click', () => trip.cancel());
trip.on('status', (st) => {
  indicator.classList.toggle('is-visible', st.state === 'routing');
  if (st.state !== 'routing') return;
  const steps = st.total > 1 ? ` · tronçon ${Math.min(st.done + 1, st.total)}/${st.total}` : '';
  indicatorText.textContent = st.slow ? `Le serveur de calcul est lent, patience…${steps}` : `Calcul de l’itinéraire…${steps}`;
  indicatorCancel.hidden = !st.slow;
});
trip.on('waypoints', (wps) => panel.setCount('trip', wps.length ? String(wps.length) : ''));

// ——— Map ready ———

// 'style.load' rather than 'load': the latter waits for the first complete render, i.e.
// every base tile, which delays the trip and overlays on slow connections.
map.once('style.load', async () => {
  setBasemap(map, basemap);
  const ctx: AppContext = {
    map,
    trip,
    openPopup,
    closePopup: () => popup.remove(),
    placeActions,
    toast,
    basemap: () => basemap,
    onBasemapChange: (fn) => basemapHandlers.push(fn),
    setOverlayVisible: (id, v) => overlays.setVisible(id, v),
  };
  routeLayer = new RouteLayer(map, trip, (stage) => {
    panel.select('trip');
    panel.reveal('half');
    requestAnimationFrame(() => tripPanel.scrollToNight(stage.day));
  });
  await overlays.init(ctx);
  basemapHandlers.forEach((fn) => fn(basemap));

  map.on('click', (e) => {
    const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
    const pad = window.matchMedia('(pointer: coarse)').matches ? 12 : 5;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [e.point.x - pad, e.point.y - pad],
      [e.point.x + pad, e.point.y + pad],
    ];
    for (const { overlay, layer } of overlays.interactiveLayers()) {
      if (!map.getLayer(layer)) continue;
      const feature = map.queryRenderedFeatures(box, { layers: [layer] })[0];
      if (!feature) continue;
      const content = overlay.popupFor?.(feature, lngLat);
      if (content) openPopup(lngLat, content);
      return;
    }
    // A click on empty map first dismisses the open popup; the next one inspects the spot.
    if (popup.isOpen()) popup.remove();
    else pointPopup(lngLat);
  });

  if (restore(trip)) fitRoute();
  persist(trip);
});

map.on('error', (e) => {
  // Tile errors are expected offshore or when a server hiccups; keep the console readable.
  if ((e.error as { status?: number })?.status === 404) return;
  console.warn(e.error);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') popup.remove();
});
