import type * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { SLOTS, type BasemapId } from '../map/createMap';
import { h } from '../lib/dom';
import { iconEl } from '../ui/icons';
import type { AppContext, Overlay } from './types';

export interface CycleRoute {
  i: number;
  ref: string;
  name: string;
  /** lcn: local route (or no network tag); vv: named greenway outside any route. */
  network: 'icn' | 'ncn' | 'rcn' | 'lcn' | 'vv';
  km: number;
  /** Share of the route on car-free paths, 0–1. */
  greenway: number;
  bbox: [number, number, number, number];
  website?: string;
  /** Other names: route sections, named greenways along it. */
  aka?: string[];
  /** Name too vague for the catalogue ("Voie verte"); still on the map. */
  generic?: 1;
}

export const NETWORK_LABELS: Record<CycleRoute['network'], string> = {
  icn: 'EuroVelo & international',
  ncn: 'Véloroute nationale',
  rcn: 'Véloroute régionale',
  lcn: 'Itinéraire local',
  vv: 'Voie verte',
};

export const NET_RANK = { icn: 3, ncn: 2, rcn: 1, lcn: 0, vv: 0 } as const;

let indexPromise: Promise<CycleRoute[]> | null = null;

export function loadCycleIndex(): Promise<CycleRoute[]> {
  indexPromise ??= fetch(`${import.meta.env.BASE_URL}data/cycle-routes-index.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => d.routes as CycleRoute[])
    .catch((err) => {
      indexPromise = null;
      throw err;
    });
  return indexPromise;
}

export function routeBadge(route: Pick<CycleRoute, 'ref' | 'network'>): HTMLElement | null {
  if (!route.ref) return null;
  const variant = route.network === 'icn' ? ' badge--euro' : NET_RANK[route.network] < 2 ? ' badge--regional' : '';
  return h('span', { class: `badge badge--route${variant}` }, route.ref);
}

const SOURCE = 'cycle-network';
const L = {
  highlight: 'cycle-highlight',
  casing: 'cycle-casing',
  road: 'cycle-road',
  green: 'cycle-green',
  label: 'cycle-label',
};

const PALETTE: Record<BasemapId, { euro: string; national: string; regional: string; casing: string; halo: string }> = {
  plan: { euro: '#0e63a8', national: '#1c82c6', regional: '#4aa0d6', casing: 'rgba(255,255,255,0.92)', halo: '#0b4f86' },
  velo: { euro: '#7a2fbf', national: '#9146d6', regional: '#ad73e3', casing: 'rgba(255,255,255,0.92)', halo: '#5b1f92' },
  nuit: { euro: '#4fb0ff', national: '#6cc0ff', regional: '#8fd0ff', casing: 'rgba(5,10,20,0.9)', halo: '#123a63' },
};

/** Line width per network level; local routes and greenways are drawn a bit thinner. */
const width = (euro: number, national: number, regional: number): ExpressionSpecification =>
  ['match', ['get', 'net'], 3, euro, 2, national, 1, regional, regional * 0.8] as ExpressionSpecification;

/** Opacity 1 for networks shown at the current zoom: national first, regional from `regional`, local from `local`. */
const fadeIn = (regional: number, local: number): ExpressionSpecification =>
  [
    'step',
    ['zoom'],
    ['case', ['>=', ['get', 'net'], 2], 1, 0],
    regional,
    ['case', ['>=', ['get', 'net'], 1], 1, 0],
    local,
    1,
  ] as ExpressionSpecification;

export interface CycleRoutesOverlay extends Overlay {
  highlight(route: CycleRoute | null, fit?: boolean): void;
}

export function cycleRoutesOverlay(): CycleRoutesOverlay {
  let ctx: AppContext;
  let visible = false;
  const networks = new Set<number>([3, 2, 1, 0]);
  let greenOnly = false;
  let highlighted: CycleRoute | null = null;

  const baseFilter = (): FilterSpecification => {
    const parts: ExpressionSpecification[] = [['in', ['get', 'net'], ['literal', [...networks]]] as ExpressionSpecification];
    if (greenOnly) parts.push(['==', ['get', 'green'], 1]);
    return ['all', ...parts] as FilterSpecification;
  };

  const applyFilters = () => {
    if (!ctx) return;
    const base = baseFilter();
    ctx.map.setFilter(L.casing, base);
    ctx.map.setFilter(L.green, ['all', base, ['==', ['get', 'green'], 1]] as FilterSpecification);
    ctx.map.setFilter(L.road, ['all', base, ['==', ['get', 'green'], 0]] as FilterSpecification);
    ctx.map.setFilter(L.label, ['all', base, ['!=', ['get', 'ref'], '']] as FilterSpecification);
    ctx.map.setFilter(
      L.highlight,
      (['in', highlighted ? `,${highlighted.i},` : ',none,', ['get', 'g']] as FilterSpecification),
    );
  };

  const applyColors = (basemap: BasemapId) => {
    const p = PALETTE[basemap];
    const color = ['match', ['get', 'net'], 3, p.euro, 2, p.national, p.regional] as ExpressionSpecification;
    ctx.map.setPaintProperty(L.green, 'line-color', color);
    ctx.map.setPaintProperty(L.road, 'line-color', color);
    ctx.map.setPaintProperty(L.casing, 'line-color', p.casing);
    ctx.map.setPaintProperty(L.label, 'text-halo-color', p.halo);
  };

  const overlay: CycleRoutesOverlay = {
    id: 'cycle-routes',
    title: 'Véloroutes & voies vertes',
    description: 'EuroVelo, schéma national (V1, V2…), itinéraires régionaux et locaux, voies vertes, d’après OpenStreetMap.',
    icon: 'bike',
    slot: 'network',
    defaultVisible: true,
    interactiveLayers: [L.green, L.road],

    init(c) {
      ctx = c;
      const map = ctx.map;
      map.addSource(SOURCE, {
        type: 'vector',
        tiles: [new URL(`${import.meta.env.BASE_URL}tiles/cycle/{z}/{x}/{y}.pbf`, location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}')],
        minzoom: 4,
        maxzoom: 11,
        bounds: [-5.9, 41.2, 10.2, 51.35],
      });
      // Regional routes appear from zoom 7 and local ones from 9, to keep wide views readable.

      const hidden = { visibility: 'none' as const };
      map.addLayer(
        {
          id: L.highlight,
          type: 'line',
          source: SOURCE,
          'source-layer': 'cycle',
          layout: { ...hidden, 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#f5a524',
            'line-opacity': 0.55,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 7, 10, 12, 14, 18],
            'line-blur': 1,
          },
        },
        SLOTS.network,
      );
      map.addLayer(
        {
          id: L.casing,
          type: 'line',
          source: SOURCE,
          'source-layer': 'cycle',
          minzoom: 7,
          layout: { ...hidden, 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': PALETTE.plan.casing,
            'line-opacity': fadeIn(8, 10),
            'line-width': ['interpolate', ['linear'], ['zoom'], 7, width(3.6, 3, 0), 10, width(5.5, 4.8, 3.6), 14, width(8.5, 7.5, 6)],
          },
        },
        SLOTS.network,
      );
      map.addLayer(
        {
          id: L.road,
          type: 'line',
          source: SOURCE,
          'source-layer': 'cycle',
          layout: { ...hidden, 'line-join': 'round' },
          paint: {
            'line-color': PALETTE.plan.national,
            'line-opacity': fadeIn(7, 9),
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, width(1.6, 1.1, 0.6), 10, width(3, 2.6, 1.8), 14, width(5, 4.4, 3.6)],
            'line-dasharray': [1.6, 1.1],
          },
        },
        SLOTS.network,
      );
      map.addLayer(
        {
          id: L.green,
          type: 'line',
          source: SOURCE,
          'source-layer': 'cycle',
          layout: { ...hidden, 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': PALETTE.plan.national,
            'line-opacity': fadeIn(7, 9),
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, width(1.8, 1.3, 0.7), 10, width(3.4, 3, 2), 14, width(5.5, 4.8, 4)],
          },
        },
        SLOTS.network,
      );
      map.addLayer(
        {
          id: L.label,
          type: 'symbol',
          source: SOURCE,
          'source-layer': 'cycle',
          minzoom: 9,
          layout: {
            ...hidden,
            'symbol-placement': 'line',
            'symbol-spacing': 420,
            'text-field': ['get', 'ref'],
            'text-font': ['Noto Sans Medium'],
            'text-size': 11,
            'text-letter-spacing': 0.04,
            'text-rotation-alignment': 'viewport',
            'text-pitch-alignment': 'viewport',
            'text-padding': 6,
          },
          paint: { 'text-color': '#ffffff', 'text-halo-color': PALETTE.plan.halo, 'text-halo-width': 5, 'text-halo-blur': 0 },
        },
        SLOTS.points,
      );
      applyFilters();
      applyColors(ctx.basemap());
      ctx.onBasemapChange(applyColors);

      for (const id of [L.green, L.road]) {
        map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
      }
    },

    setVisible(v) {
      visible = v;
      for (const id of Object.values(L)) ctx.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    },

    highlight(route, fit = true) {
      highlighted = route;
      applyFilters();
      if (route && !visible) ctx.setOverlayVisible(overlay.id, true);
      if (route && fit) {
        const [w, s, e, n] = route.bbox;
        ctx.map.fitBounds([w, s, e, n], { padding: fitPadding(), maxZoom: 12, duration: 900 });
      }
    },

    popupFor(feature: maplibregl.MapGeoJSONFeature) {
      const props = feature.properties as { g: string; green: number; unpaved: number };
      const ids = props.g.split(',').filter(Boolean).map(Number);
      const body = h('div', { class: 'popup-routes' }, h('p', { class: 'hint' }, 'Chargement…'));
      const card = h(
        'div',
        { class: 'popup-card' },
        h('div', { class: 'popup-card__eyebrow' }, iconEl('bike', 14), 'Véloroute'),
        h(
          'div',
          { class: 'popup-card__facts' },
          h('span', { class: `seg-kind ${props.green ? 'is-green' : ''}` }, props.green ? 'Voie verte — sans voitures' : 'Tronçon partagé avec la route'),
          props.unpaved ? h('span', { class: 'seg-kind' }, 'Non revêtu') : null,
        ),
        body,
      );
      loadCycleIndex()
        .then((routes) => {
          const byId = new Map(routes.map((r) => [r.i, r]));
          const found = ids
            .map((i) => byId.get(i))
            .filter((r): r is CycleRoute => !!r)
            .sort((a, b) => NET_RANK[b.network] - NET_RANK[a.network] || b.km - a.km);
          body.replaceChildren(
            ...found.map((r) =>
              h(
                'div',
                { class: 'popup-route' },
                h('div', { class: 'popup-route__title' }, routeBadge(r), h('strong', null, r.name)),
                h(
                  'div',
                  { class: 'popup-route__meta' },
                  `${NETWORK_LABELS[r.network]} · ${r.km} km · ${Math.round(r.greenway * 100)} % en voie verte`,
                ),
                h(
                  'div',
                  { class: 'btn-row' },
                  h('button', { class: 'btn btn--sm', onclick: () => overlay.highlight(r) }, 'Voir tout l’itinéraire'),
                  r.website
                    ? h('a', { class: 'btn btn--sm btn--ghost', href: r.website, target: '_blank', rel: 'noopener' }, 'Site', iconEl('external', 13))
                    : null,
                ),
              ),
            ),
          );
        })
        .catch(() => body.replaceChildren(h('p', { class: 'hint' }, 'Impossible de charger la liste des véloroutes.')));
      return card;
    },

    renderControls() {
      const netChip = (net: number, label: string, color: string) => {
        const chip = h(
          'button',
          { class: 'chip', type: 'button', 'aria-pressed': String(networks.has(net)) },
          h('span', { class: 'chip__swatch', style: `background:${color}` }),
          label,
        );
        chip.addEventListener('click', () => {
          if (networks.has(net)) networks.delete(net);
          else networks.add(net);
          chip.setAttribute('aria-pressed', String(networks.has(net)));
          applyFilters();
        });
        return chip;
      };
      const greenChip = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(greenOnly) }, 'Voies vertes seulement');
      greenChip.addEventListener('click', () => {
        greenOnly = !greenOnly;
        greenChip.setAttribute('aria-pressed', String(greenOnly));
        applyFilters();
      });
      return h(
        'div',
        { class: 'overlay-controls' },
        h(
          'div',
          { class: 'legend' },
          h('div', { class: 'legend__row' }, h('span', { class: 'swatch-line', style: 'color:var(--map-cycle-national)' }), 'Voie verte, en site propre'),
          h(
            'div',
            { class: 'legend__row' },
            h('span', { class: 'swatch-line swatch-line--dashed', style: 'color:var(--map-cycle-national)' }),
            'Partagée avec la circulation',
          ),
        ),
        h(
          'div',
          { class: 'chips' },
          netChip(3, 'EuroVelo', PALETTE.plan.euro),
          netChip(2, 'Nationales', PALETTE.plan.national),
          netChip(1, 'Régionales', PALETTE.plan.regional),
          netChip(0, 'Locales', PALETTE.plan.regional),
          greenChip,
        ),
      );
    },
  };
  return overlay;
}

/** Keeps fitted content clear of the side panel / bottom sheet. */
export function fitPadding(): maplibregl.PaddingOptions {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  return mobile ? { top: 70, bottom: 200, left: 30, right: 30 } : { top: 60, bottom: 60, left: 440, right: 70 };
}
