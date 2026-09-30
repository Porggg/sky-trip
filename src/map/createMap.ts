import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

export type BasemapId = 'plan' | 'nuit' | 'velo';

export const BASEMAPS: { id: BasemapId; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'OpenStreetMap, le rendu standard' },
  { id: 'nuit', label: 'Nuit', hint: 'OpenStreetMap assombri, plus reposant le soir' },
  { id: 'velo', label: 'Vélo', hint: 'CyclOSM : aménagements cyclables détaillés' },
];

/**
 * Overlays insert their layers below one of these invisible marker layers, which keeps
 * a stable stacking order whatever the order overlays are switched on.
 */
export const SLOTS = {
  sky: 'slot:sky',
  network: 'slot:network',
  route: 'slot:route',
  points: 'slot:points',
} as const;
export type Slot = keyof typeof SLOTS;

const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">contributeurs OpenStreetMap</a>';

const FRANCE_BOUNDS: [number, number, number, number] = [-5.6, 41.2, 9.9, 51.3];

function style(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: OSM_ATTRIBUTION,
      },
      cyclosm: {
        type: 'raster',
        tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 20,
        attribution: `<a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> · ${OSM_ATTRIBUTION}`,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0a0f1c' } },
      { id: 'base-osm', type: 'raster', source: 'osm', paint: { 'raster-fade-duration': 150 } },
      { id: 'base-cyclosm', type: 'raster', source: 'cyclosm', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150 } },
      ...Object.values(SLOTS).map((id) => ({ id, type: 'background' as const, layout: { visibility: 'none' as const }, paint: {} })),
    ],
  };
}

export function createMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: style(),
    bounds: FRANCE_BOUNDS,
    fitBoundsOptions: { padding: 20 },
    maxZoom: 18,
    minZoom: 4,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-right');
  // MapLibre opens the compact attribution on wide screens; keep it folded behind its ⓘ button.
  map.once('idle', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  return map;
}

export function setBasemap(map: maplibregl.Map, id: BasemapId) {
  map.setLayoutProperty('base-osm', 'visibility', id === 'velo' ? 'none' : 'visible');
  map.setLayoutProperty('base-cyclosm', 'visibility', id === 'velo' ? 'visible' : 'none');
  // "Nuit" inverts the OSM tiles' lightness, then rotates hues back so water stays blue.
  const night = id === 'nuit';
  map.setPaintProperty('base-osm', 'raster-brightness-min', night ? 0.92 : 0);
  map.setPaintProperty('base-osm', 'raster-brightness-max', night ? 0.06 : 1);
  map.setPaintProperty('base-osm', 'raster-hue-rotate', night ? 180 : 0);
  map.setPaintProperty('base-osm', 'raster-saturation', night ? -0.55 : 0);
  map.setPaintProperty('base-osm', 'raster-contrast', night ? 0.08 : 0);
}

/** Loads an SVG string as a map icon (rendered at 2× for crisp edges). */
export function addSvgImage(map: maplibregl.Map, name: string, markup: string, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image(size * 2, size * 2);
    img.onload = () => {
      if (!map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}
