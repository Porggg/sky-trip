import type * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { SLOTS, addSvgImage } from '../map/createMap';
import { h } from '../lib/dom';
import { glyph, iconEl } from '../ui/icons';
import type { LngLat } from '../lib/geo';
import type { AppContext, Overlay } from './types';

export type ServiceId = 'tgv' | 'ouigo' | 'intl' | 'ic' | 'icn' | 'ter' | 'tramtrain' | 'rer' | 'transilien';

export const SERVICES: Record<ServiceId, { label: string; color: string; bike: string }> = {
  tgv: {
    label: 'TGV INOUI',
    color: '#9b2242',
    bike: 'Vélo non démonté sur réservation d’un emplacement (payant) ; vélo démonté en housse accepté sans supplément.',
  },
  ouigo: { label: 'OUIGO', color: '#c0457d', bike: 'Vélo démonté, rangé dans une housse, avec l’option bagage vélo.' },
  intl: { label: 'Lyria / ICE', color: '#6f3a8c', bike: 'Vélo sur réservation, places limitées selon le train.' },
  ic: { label: 'Intercités', color: '#2e5aa8', bike: 'Vélo non démonté, réservation obligatoire (payante sur la plupart des lignes).' },
  icn: { label: 'Intercités de nuit', color: '#23306b', bike: 'Emplacements vélo à réserver, en nombre limité.' },
  ter: { label: 'TER', color: '#1f7a8c', bike: 'Vélo non démonté accepté sans réservation dans la limite des places ; réservation parfois obligatoire l’été.' },
  tramtrain: { label: 'Tram-train', color: '#3f8f5a', bike: 'Vélos acceptés selon l’affluence.' },
  rer: { label: 'RER', color: '#475569', bike: 'Vélos acceptés hors heures de pointe en semaine (6 h 30 – 9 h 30 et 16 h 30 – 19 h 30).' },
  transilien: { label: 'Transilien', color: '#5b6b82', bike: 'Vélos acceptés hors heures de pointe en semaine (6 h 30 – 9 h 30 et 16 h 30 – 19 h 30).' },
};

/** Filter groups shown as chips. */
const FILTERS: { id: string; label: string; services: ServiceId[] }[] = [
  { id: 'ter', label: 'TER', services: ['ter', 'tramtrain'] },
  { id: 'tgv', label: 'TGV & OUIGO', services: ['tgv', 'ouigo', 'intl'] },
  { id: 'ic', label: 'Intercités', services: ['ic', 'icn'] },
  { id: 'idf', label: 'RER & Transilien', services: ['rer', 'transilien'] },
];

const SOURCE = 'stations';
const L = { dot: 'stations-dot', icon: 'stations-icon' };
const MAJOR: ExpressionSpecification = [
  'any',
  ...(['tgv', 'ouigo', 'intl', 'ic', 'icn'] as const).map((s) => ['in', s, ['get', 'services']] as ExpressionSpecification),
] as ExpressionSpecification;
/** Long-distance stations with a busy timetable: the only ones shown at country scale. */
const BUSY: ExpressionSpecification = ['all', MAJOR, ['>=', ['get', 'departures'], 25]];

function stationIcon(major: boolean): string {
  const size = major ? 26 : 20;
  const inset = major ? 3 : 2.5;
  const g = size - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 ${size} ${size}">
    <rect x="0.75" y="0.75" width="${size - 1.5}" height="${size - 1.5}" rx="${major ? 7 : 6}" fill="#16223a" stroke="#ffffff" stroke-width="1.5"/>
    <g transform="translate(${inset} ${inset}) scale(${g / 24})">${glyph('train', '#ffffff', 2)}</g>
  </svg>`;
}

export function stationsOverlay(): Overlay {
  let ctx: AppContext;
  const enabled = new Set(FILTERS.map((f) => f.id));

  const applyFilter = () => {
    const services = FILTERS.filter((f) => enabled.has(f.id)).flatMap((f) => f.services);
    const filter = ['any', ...services.map((s) => ['in', s, ['get', 'services']])] as FilterSpecification;
    ctx.map.setFilter(L.dot, filter);
    ctx.map.setFilter(L.icon, filter);
  };

  return {
    id: 'stations',
    title: 'Gares',
    description: 'Gares SNCF desservies par des trains : TER, TGV, OUIGO, Intercités, RER et Transilien.',
    icon: 'train',
    slot: 'points',
    defaultVisible: true,
    interactiveLayers: [L.icon, L.dot],

    async init(c) {
      ctx = c;
      const map = ctx.map;
      await Promise.all([addSvgImage(map, 'station', stationIcon(false), 20), addSvgImage(map, 'station-major', stationIcon(true), 26)]);
      map.addSource(SOURCE, {
        type: 'geojson',
        data: `${import.meta.env.BASE_URL}data/stations.geojson`,
        attribution: 'SNCF Open Data',
      });
      map.addLayer(
        {
          id: L.dot,
          type: 'circle',
          source: SOURCE,
          maxzoom: 9,
          layout: { visibility: 'none', 'circle-sort-key': ['get', 'departures'] },
          paint: {
            'circle-color': '#16223a',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 8, 1.4],
            // Country scale: busy long-distance stations; then all TGV / Intercités; every station from 7.5.
            'circle-opacity': ['step', ['zoom'], ['case', BUSY, 1, 0], 6.5, ['case', MAJOR, 1, 0], 7.5, 1],
            'circle-stroke-opacity': ['step', ['zoom'], ['case', BUSY, 1, 0], 6.5, ['case', MAJOR, 1, 0], 7.5, 1],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['case', MAJOR, 3, 0], 7, ['case', MAJOR, 4.5, 2.6], 9, ['case', MAJOR, 6, 4]],
          },
        },
        SLOTS.points,
      );
      map.addLayer(
        {
          id: L.icon,
          type: 'symbol',
          source: SOURCE,
          minzoom: 8.5,
          layout: {
            visibility: 'none',
            'icon-image': ['case', MAJOR, 'station-major', 'station'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 8.5, 0.8, 12, 1],
            'icon-allow-overlap': true,
            'symbol-sort-key': ['-', 0, ['get', 'departures']],
            'text-field': ['step', ['zoom'], ['case', MAJOR, ['get', 'name'], ''], 10.5, ['get', 'name']],
            'text-font': ['Noto Sans Medium'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 13],
            'text-anchor': 'top',
            'text-offset': [0, 1.15],
            'text-optional': true,
            'text-max-width': 9,
          },
          paint: {
            'text-color': '#16223a',
            'text-halo-color': 'rgba(255,255,255,0.95)',
            'text-halo-width': 1.6,
          },
        },
        SLOTS.points,
      );
      applyFilter();
      for (const id of [L.icon, L.dot]) {
        map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
      }
      ctx.onBasemapChange((b) => {
        map.setPaintProperty(L.icon, 'text-color', b === 'nuit' ? '#e8ecf5' : '#16223a');
        map.setPaintProperty(L.icon, 'text-halo-color', b === 'nuit' ? 'rgba(8,12,22,0.9)' : 'rgba(255,255,255,0.95)');
      });
    },

    setVisible(visible) {
      for (const id of Object.values(L)) ctx.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    },

    popupFor(feature: maplibregl.MapGeoJSONFeature) {
      const p = feature.properties as { name: string; services: string; lines: string; departures: number };
      const services = (p.services || '').split(',').filter(Boolean) as ServiceId[];
      const lines = (p.lines || '').split('|').filter(Boolean);
      const coord = (feature.geometry as GeoJSON.Point).coordinates as LngLat;
      const rules = new Map<string, string[]>();
      for (const s of services) {
        const rule = SERVICES[s].bike;
        rules.set(rule, [...(rules.get(rule) ?? []), SERVICES[s].label]);
      }
      return h(
        'div',
        { class: 'popup-card' },
        h('div', { class: 'popup-card__eyebrow' }, iconEl('train', 14), 'Gare'),
        h('h3', { class: 'popup-card__title' }, p.name),
        h(
          'div',
          { class: 'chips chips--static' },
          services.map((s) => h('span', { class: 'service', style: `--c:${SERVICES[s].color}` }, SERVICES[s].label)),
        ),
        h(
          'p',
          { class: 'popup-card__meta' },
          p.departures > 0
            ? `Environ ${p.departures} départs un jour de semaine`
            : 'Aucun départ le jour de référence : desserte saisonnière, week-end ou travaux.',
        ),
        lines.length
          ? h(
              'details',
              { class: 'popup-card__details' },
              h('summary', null, `Lignes (${lines.length}${lines.length >= 8 ? '+' : ''})`),
              h('ul', null, lines.map((l) => h('li', null, l))),
            )
          : null,
        h(
          'div',
          { class: 'bike-rules' },
          h('div', { class: 'bike-rules__title' }, iconEl('bike', 14), 'Voyager avec son vélo'),
          [...rules.entries()].map(([rule, labels]) => h('p', null, h('strong', null, `${labels.join(', ')} : `), rule)),
          h('p', { class: 'hint' }, 'Règles indicatives : vérifiez au moment de réserver.'),
        ),
        ctx.placeActions(coord, { name: `Gare de ${p.name.replace(/^Gare de /, '')}`, kind: 'station' }),
        h(
          'a',
          { class: 'popup-card__link', href: 'https://www.sncf-connect.com/', target: '_blank', rel: 'noopener' },
          'Horaires et billets sur SNCF Connect',
          iconEl('external', 13),
        ),
      );
    },

    renderControls() {
      return h(
        'div',
        { class: 'overlay-controls' },
        h(
          'div',
          { class: 'chips' },
          FILTERS.map((f) => {
            const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true' }, f.label);
            chip.addEventListener('click', () => {
              if (enabled.has(f.id)) enabled.delete(f.id);
              else enabled.add(f.id);
              chip.setAttribute('aria-pressed', String(enabled.has(f.id)));
              applyFilter();
            });
            return chip;
          }),
        ),
        h('p', { class: 'hint' }, 'Horaires SNCF open data. Les gares desservies uniquement par car ne sont pas affichées.'),
      );
    },
  };
}
