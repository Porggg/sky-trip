// The "Calques" tab: basemap choice, then one card per overlay with its switch and controls.
import { h, svg } from '../lib/dom';
import { BASEMAPS, type BasemapId } from '../map/createMap';
import type { OverlayManager } from '../overlays';
import { icon } from './icons';

export function createLayersPanel(root: HTMLElement, manager: OverlayManager, basemap: { get(): BasemapId; set(id: BasemapId): void }) {
  const baseButtons = BASEMAPS.map((b) => {
    const btn = h('button', { type: 'button', 'aria-pressed': String(b.id === basemap.get()), title: b.hint }, b.label);
    btn.addEventListener('click', () => {
      basemap.set(b.id);
      baseButtons.forEach((x, i) => x.setAttribute('aria-pressed', String(BASEMAPS[i].id === b.id)));
      baseHint.textContent = b.hint;
    });
    return btn;
  });
  const baseHint = h('p', { class: 'hint' }, BASEMAPS.find((b) => b.id === basemap.get())!.hint);

  const cards = manager.overlays.map((overlay) => {
    const sw = h('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(manager.isVisible(overlay.id)),
      'aria-label': `Afficher ${overlay.title}`,
    });
    const status = h('p', { class: 'overlay-status', 'aria-live': 'polite' });
    overlay.onStatus?.((text) => {
      status.textContent = text;
      status.hidden = !text;
    });
    status.hidden = true;
    const controls = overlay.renderControls?.() ?? null;
    const glyph = svg(icon(overlay.icon, 18));
    glyph.classList.add('overlay-card__icon');
    const card = h(
      'article',
      { class: 'overlay-card' },
      h(
        'header',
        { class: 'overlay-card__head' },
        glyph,
        h('div', { class: 'overlay-card__text' }, h('h3', { class: 'overlay-card__title' }, overlay.title), h('p', { class: 'overlay-card__desc' }, overlay.description)),
        sw,
      ),
      status,
      controls,
    );
    const sync = (visible: boolean) => {
      sw.setAttribute('aria-checked', String(visible));
      card.classList.toggle('is-off', !visible);
    };
    sync(manager.isVisible(overlay.id));
    sw.addEventListener('click', () => manager.setVisible(overlay.id, !manager.isVisible(overlay.id)));
    manager.on('visibility', ({ id, visible }) => id === overlay.id && sync(visible));
    return card;
  });

  root.append(
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section__title' }, 'Fond de carte'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Fond de carte' }, baseButtons),
      baseHint,
    ),
    h('div', { class: 'section' }, h('div', { class: 'section__title' }, 'Informations affichées'), h('div', { class: 'overlay-list' }, cards)),
    h(
      'p',
      { class: 'hint credits' },
      'Sources ouvertes : OpenStreetMap, SNCF Open Data, atlas de pollution lumineuse de D. J. Lorenz, calcul d’itinéraire BRouter, recherche Photon.',
    ),
  );
}
