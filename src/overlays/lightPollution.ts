import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { SLOTS } from '../map/createMap';
import { h } from '../lib/dom';
import { ATLAS_YEAR, ZONES } from '../sky/lightAtlas';
import type { AppContext, Overlay } from './types';

const SOURCE = 'light-pollution';
const LAYER = 'light-pollution';
const OPACITY_KEY = 'sky-trip:lp-opacity';

function readOpacity(): number {
  try {
    const v = Number(localStorage.getItem(OPACITY_KEY));
    return v > 0 && v <= 1 ? v : 0.45;
  } catch {
    return 0.45;
  }
}

/** The atlas is ~700 m per pixel: fade it when zoomed in so streets stay readable. */
function opacityByZoom(base: number): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 9, base, 14, base * 0.4];
}

export function lightPollutionOverlay(): Overlay {
  let ctx: AppContext;
  let opacity = readOpacity();

  return {
    id: 'light-pollution',
    title: 'Pollution lumineuse',
    description: `Luminosité artificielle du ciel au zénith — atlas ${ATLAS_YEAR} de David J. Lorenz, d’après les images satellite VIIRS.`,
    icon: 'sparkle',
    slot: 'sky',
    defaultVisible: true,

    init(c) {
      ctx = c;
      ctx.map.addSource(SOURCE, {
        type: 'raster',
        tiles: [`https://djlorenz.github.io/astronomy/image_tiles/tiles${ATLAS_YEAR}/tile_{z}_{x}_{y}.png`],
        tileSize: 1024,
        minzoom: 0,
        maxzoom: 6,
        attribution: `<a href="https://djlorenz.github.io/astronomy/lp/" target="_blank" rel="noopener">Atlas D. J. Lorenz ${ATLAS_YEAR}</a>`,
      });
      ctx.map.addLayer(
        {
          id: LAYER,
          type: 'raster',
          source: SOURCE,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': opacityByZoom(opacity), 'raster-resampling': 'linear', 'raster-fade-duration': 200 },
        },
        SLOTS.sky,
      );
    },

    setVisible(visible) {
      ctx.map.setLayoutProperty(LAYER, 'visibility', visible ? 'visible' : 'none');
    },

    renderControls() {
      // One colour per atlas zone, grouped under our plain-language labels.
      const groups: { label: string; colors: string[] }[] = [];
      for (const z of ZONES) {
        const last = groups[groups.length - 1];
        if (last && last.label === z.label) last.colors.push(z.color);
        else groups.push({ label: z.label, colors: [z.color] });
      }
      const scale = h(
        'div',
        { class: 'lp-scale', role: 'img', 'aria-label': 'Échelle de couleurs, du ciel le plus noir au plus lumineux' },
        ZONES.map((z) => h('span', { style: `background:${z.color}` })),
      );
      const labels = h(
        'div',
        { class: 'lp-scale__labels' },
        h('span', null, 'Ciel noir'),
        h('span', null, 'Campagne'),
        h('span', null, 'Périurbain'),
        h('span', null, 'Ville'),
      );

      const slider = h('input', {
        class: 'range',
        type: 'range',
        min: '15',
        max: '90',
        step: '5',
        value: String(Math.round(opacity * 100)),
        'aria-label': 'Opacité de la couche',
      });
      slider.addEventListener('input', () => {
        opacity = Number(slider.value) / 100;
        ctx.map.setPaintProperty(LAYER, 'raster-opacity', opacityByZoom(opacity));
        try {
          localStorage.setItem(OPACITY_KEY, String(opacity));
        } catch {
          // ignore
        }
      });

      return h(
        'div',
        { class: 'overlay-controls' },
        scale,
        labels,
        h('label', { class: 'range-field' }, h('span', { class: 'field__label' }, 'Opacité'), slider),
        h(
          'p',
          { class: 'hint' },
          'Cliquez n’importe où sur la carte pour connaître la qualité du ciel à cet endroit. ',
          'Modèle calculé, pas une mesure : ce n’est pas l’échelle de Bortle.',
        ),
      );
    },
  };
}
