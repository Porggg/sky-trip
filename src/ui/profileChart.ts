// Elevation profile with the sky-quality strip underneath, drawn in SVG.
import { h } from '../lib/dom';
import { along, type LngLat } from '../lib/geo';
import type { SkyReading } from '../sky/lightAtlas';
import type { RouteSummary } from '../route/trip';
import type { Stage } from '../route/stages';

const NS = 'http://www.w3.org/2000/svg';
const W = 360;
const H = 150;
const PAD = { top: 10, right: 8, bottom: 38, left: 34 };
const BAND_H = 8;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export interface ProfileSample {
  d: number;
  sky: SkyReading | null;
}

export function renderProfile(
  route: RouteSummary,
  stages: Stage[],
  sky: ProfileSample[] | null,
  onHover: (point: LngLat | null) => void,
): HTMLElement {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'profile__svg', role: 'img', 'aria-label': 'Profil altimétrique et qualité du ciel le long du parcours' });
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const L = route.length || 1;

  // Downsample to ~1 point per SVG pixel.
  const step = Math.max(1, Math.floor(route.coords.length / innerW));
  const pts: [number, number][] = [];
  for (let i = 0; i < route.coords.length; i += step) pts.push([route.cum[i], route.coords[i][2] ?? 0]);
  const lastIdx = route.coords.length - 1;
  pts.push([route.cum[lastIdx], route.coords[lastIdx][2] ?? 0]);

  let min = Math.min(...pts.map((p) => p[1]));
  let max = Math.max(...pts.map((p) => p[1]));
  if (max - min < 60) {
    const mid = (max + min) / 2;
    min = mid - 30;
    max = mid + 30;
  }
  const pad = (max - min) * 0.1;
  min = Math.max(-50, min - pad);
  max += pad;

  const x = (d: number) => PAD.left + (d / L) * innerW;
  const y = (e: number) => PAD.top + innerH - ((e - min) / (max - min)) * innerH;

  const defs = el('defs', {});
  const grad = el('linearGradient', { id: 'profile-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el('stop', { offset: '0%', 'stop-color': '#8fb4ff', 'stop-opacity': 0.32 }), el('stop', { offset: '100%', 'stop-color': '#8fb4ff', 'stop-opacity': 0.02 }));
  defs.append(grad);
  svg.append(defs);

  // Horizontal guides with elevation labels.
  for (const e of [min + (max - min) * 0.15, (min + max) / 2, max - (max - min) * 0.1]) {
    const rounded = Math.round(e / 10) * 10;
    svg.append(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(rounded), y2: y(rounded), class: 'profile__grid' }));
    const t = el('text', { x: PAD.left - 6, y: y(rounded) + 3, class: 'profile__label', 'text-anchor': 'end' });
    t.textContent = `${rounded}`;
    svg.append(t);
  }

  const line = pts.map(([d, e], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(e).toFixed(1)}`).join('');
  svg.append(el('path', { d: `${line}L${x(L)},${PAD.top + innerH}L${x(0)},${PAD.top + innerH}Z`, fill: 'url(#profile-fill)' }));
  svg.append(el('path', { d: line, class: 'profile__line' }));

  // Night stops.
  for (const s of stages.filter((st) => !st.last)) {
    svg.append(el('line', { x1: x(s.to), x2: x(s.to), y1: PAD.top, y2: PAD.top + innerH, class: 'profile__stage' }));
    const t = el('text', { x: x(s.to), y: PAD.top + 8, class: 'profile__stage-label', 'text-anchor': 'middle' });
    t.textContent = `N${s.day}`;
    svg.append(t);
  }

  // Sky strip.
  const bandY = PAD.top + innerH + 6;
  const band = el('g', { class: 'profile__band' });
  if (sky && sky.length > 1) {
    sky.forEach((s, i) => {
      const next = sky[i + 1]?.d ?? L;
      band.append(el('rect', { x: x(s.d), y: bandY, width: Math.max(0.5, x(next) - x(s.d) + 0.4), height: BAND_H, fill: s.sky?.zone.color ?? '#333' }));
    });
  } else {
    band.append(el('rect', { x: PAD.left, y: bandY, width: innerW, height: BAND_H, fill: '#1d2840', class: 'profile__band-loading' }));
  }
  svg.append(band);
  const bandLabel = el('text', { x: PAD.left - 6, y: bandY + 7, class: 'profile__label', 'text-anchor': 'end' });
  bandLabel.textContent = 'ciel';
  svg.append(bandLabel);

  // Distance ticks.
  const km = L / 1000;
  const tickStep = [5, 10, 20, 25, 50, 100, 200].find((s) => km / s <= 6) ?? 500;
  for (let k = 0; k <= km; k += tickStep) {
    const t = el('text', { x: x(k * 1000), y: H - 6, class: 'profile__label', 'text-anchor': k === 0 ? 'start' : 'middle' });
    t.textContent = k === 0 ? '0 km' : String(k);
    svg.append(t);
  }

  // Hover cursor.
  const cursor = el('line', { x1: 0, x2: 0, y1: PAD.top, y2: bandY + BAND_H, class: 'profile__cursor', visibility: 'hidden' });
  svg.append(cursor);
  const tooltip = h('div', { class: 'profile__tooltip', hidden: true });
  const wrap = h('div', { class: 'profile' }, tooltip);
  wrap.prepend(svg);

  const move = (clientX: number) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const d = Math.max(0, Math.min(L, ((px - PAD.left) / innerW) * L));
    const xx = x(d);
    cursor.setAttribute('x1', String(xx));
    cursor.setAttribute('x2', String(xx));
    cursor.setAttribute('visibility', 'visible');
    // Elevation at d
    let i = 0;
    while (i < route.cum.length - 1 && route.cum[i] < d) i++;
    const ele = route.coords[i][2];
    const s = sky?.reduce((best, cur) => (Math.abs(cur.d - d) < Math.abs(best.d - d) ? cur : best));
    tooltip.hidden = false;
    tooltip.textContent = `${(d / 1000).toFixed(1).replace('.', ',')} km · ${ele != null ? `${Math.round(ele)} m` : '—'}${s?.sky ? ` · ciel ${s.sky.zone.label.toLowerCase()}` : ''}`;
    tooltip.style.left = `${(xx / W) * 100}%`;
    onHover(along(route.coords, route.cum, d));
  };
  const leave = () => {
    cursor.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
    onHover(null);
  };
  svg.addEventListener('pointermove', (e) => move(e.clientX));
  svg.addEventListener('pointerdown', (e) => move(e.clientX));
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointercancel', leave);
  return wrap;
}
