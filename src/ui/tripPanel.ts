// The "Itinéraire" tab: waypoints, routing options, trip summary, profile and nights.
import { h, svg } from '../lib/dom';
import * as fmt from '../lib/format';
import { along, type LngLat } from '../lib/geo';
import { placeName } from '../lib/geocode';
import { bookingSearchUrl } from '../lib/booking';
import { PRIORITIES, PROFILES, supportsPriority } from '../route/brouter';
import { splitStages, type Stage } from '../route/stages';
import { toGpx, download } from '../route/gpx';
import { shareUrl } from '../route/share';
import type { RouteSummary, Trip, Waypoint } from '../route/trip';
import { waypointLabel } from '../map/routeLayer';
import { skyAlong, skyAt, type SkyReading } from '../sky/lightAtlas';
import { eveningOf, forecastNight, nightScore, type NightForecast } from '../sky/night';
import { renderProfile, type ProfileSample } from './profileChart';
import { icon, type IconName } from './icons';

interface Deps {
  trip: Trip;
  onHover(point: LngLat | null): void;
  onStages(stages: Stage[]): void;
  fitRoute(): void;
  focus(lngLat: LngLat, zoom?: number): void;
  showLodgingAround(lngLat: LngLat): void;
  toast(message: string): void;
}

const SAMPLES: { title: string; text: string; waypoints: Omit<Waypoint, 'id'>[]; kmPerDay: number }[] = [
  {
    title: 'Haute-Provence, sur les pas des astronomes',
    text: 'Manosque → Observatoire de Haute-Provence → Banon → Sisteron. Un des ciels les plus noirs de France.',
    kmPerDay: 45,
    waypoints: [
      { lngLat: [5.79332, 43.82319], name: 'Gare de Manosque', kind: 'station' },
      { lngLat: [5.7156, 43.9316], name: 'Observatoire de Haute-Provence', kind: 'place' },
      { lngLat: [5.6297, 44.0381], name: 'Banon', kind: 'place' },
      { lngLat: [5.94658, 44.19022], name: 'Gare de Sisteron', kind: 'station' },
    ],
  },
  {
    title: 'La Loire à Vélo, de Tours à Saumur',
    text: 'Deux jours faciles le long de la Loire, entre deux gares TER.',
    kmPerDay: 40,
    waypoints: [
      { lngLat: [0.69283, 47.38987], name: 'Gare de Tours', kind: 'station' },
      { lngLat: [-0.0714, 47.26899], name: 'Gare de Saumur', kind: 'station' },
    ],
  },
];

function nightQuality(score: number): { label: string; tone: string } {
  if (score >= 0.75) return { label: 'Excellente nuit', tone: 'great' };
  if (score >= 0.55) return { label: 'Bonne nuit', tone: 'good' };
  if (score >= 0.35) return { label: 'Nuit correcte', tone: 'fair' };
  return { label: 'Peu favorable', tone: 'poor' };
}

function moonPhaseName(fraction: number, waxing: boolean): string {
  if (fraction < 0.04) return 'nouvelle lune';
  if (fraction > 0.96) return 'pleine lune';
  if (Math.abs(fraction - 0.5) < 0.08) return waxing ? 'premier quartier' : 'dernier quartier';
  if (fraction < 0.5) return waxing ? 'premier croissant' : 'dernier croissant';
  return waxing ? 'gibbeuse croissante' : 'gibbeuse décroissante';
}

function moonGlyph(fraction: number, waxing: boolean): SVGElement {
  // Lit part drawn as an ellipse-bounded crescent.
  const r = 7;
  const k = 1 - 2 * fraction; // 1 = new, -1 = full
  const sweep = waxing ? 1 : 0;
  const rx = Math.abs(k) * r;
  const d = `M8 1 A${r} ${r} 0 0 ${sweep} 8 15 A${rx.toFixed(2)} ${r} 0 0 ${k > 0 ? 1 - sweep : sweep} 8 1Z`;
  return svg(
    `<svg class="moon-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#28354f"/><path d="${d}" fill="#f3e6c4"/></svg>`,
  );
}

function iconEl(name: IconName, size = 16) {
  return svg(icon(name, size));
}

export function createTripPanel(root: HTMLElement, deps: Deps) {
  const { trip } = deps;
  const waypointsSection = h('div', { class: 'section' });
  const settingsSection = h('div', { class: 'section' });
  const statusEl = h('div', { class: 'trip-status', 'aria-live': 'polite' });
  const summarySection = h('div', { class: 'section' });
  const stagesSection = h('div', { class: 'section' });
  root.append(waypointsSection, statusEl, summarySection, stagesSection, settingsSection);

  let renderToken = 0;
  let stages: Stage[] = [];

  // ——— waypoints ———

  const renderWaypoints = () => {
    const wps = trip.waypoints;
    if (!wps.length) {
      waypointsSection.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          h('h2', { class: 'empty__title' }, 'Où partez-vous pédaler ?'),
          h('p', { class: 'empty__text' }, 'Composez votre voyage directement sur la carte.'),
          h(
            'ol',
            { class: 'steps' },
            h('li', null, 'Cliquez sur la carte, une gare ou un hébergement, puis choisissez « Départ ».'),
            h('li', null, 'Ajoutez l’arrivée et, si besoin, des étapes : le tracé suit les véloroutes.'),
            h('li', null, 'Réglez votre rythme : chaque nuit est notée selon le ciel et la Lune.'),
          ),
        ),
        h(
          'div',
          { class: 'samples' },
          h('div', { class: 'section__title' }, 'Ou partez d’un exemple'),
          SAMPLES.map((s) =>
            h(
              'button',
              {
                class: 'sample',
                type: 'button',
                onclick: () => {
                  trip.load(s.waypoints, { kmPerDay: s.kmPerDay });
                  deps.fitRoute();
                },
              },
              h('span', { class: 'sample__title' }, s.title),
              h('span', { class: 'sample__text' }, s.text),
              iconEl('right', 16),
            ),
          ),
        ),
      );
      return;
    }

    const list = h('ol', { class: 'waypoints', 'aria-label': 'Points du parcours' });
    wps.forEach((wp, i) => {
      const last = i === wps.length - 1 && wps.length > 1;
      const role = i === 0 ? 'Départ' : last ? 'Arrivée' : `Étape ${i}`;
      const label = wp.name ?? `${wp.lngLat[1].toFixed(4)}, ${wp.lngLat[0].toFixed(4)}`;
      list.append(
        h(
          'li',
          { class: 'waypoint' },
          h('span', { class: `waypoint__badge${i === 0 ? ' is-start' : ''}${last ? ' is-end' : ''}` }, waypointLabel(i)),
          h(
            'button',
            { class: 'waypoint__text', type: 'button', title: 'Centrer la carte', onclick: () => deps.focus(wp.lngLat, 13) },
            h('span', { class: 'waypoint__role' }, role, wp.kind === 'station' ? iconEl('train', 12) : null, wp.kind === 'lodging' ? iconEl('bed', 12) : null),
            h('span', { class: `waypoint__name${wp.name ? '' : ' is-pending'}` }, label),
          ),
          h(
            'span',
            { class: 'waypoint__actions' },
            h('button', { class: 'btn btn--ghost btn--icon', type: 'button', 'aria-label': `Monter ${role}`, disabled: i === 0, onclick: () => trip.shift(wp.id, -1) }, iconEl('up')),
            h(
              'button',
              { class: 'btn btn--ghost btn--icon', type: 'button', 'aria-label': `Descendre ${role}`, disabled: i === wps.length - 1, onclick: () => trip.shift(wp.id, 1) },
              iconEl('down'),
            ),
            h('button', { class: 'btn btn--ghost btn--icon', type: 'button', 'aria-label': `Retirer ${role}`, onclick: () => trip.remove(wp.id) }, iconEl('close')),
          ),
        ),
      );
    });

    const hint =
      wps.length === 1
        ? h('p', { class: 'hint waypoints__hint' }, 'Cliquez maintenant sur la carte pour choisir l’arrivée.')
        : h('p', { class: 'hint waypoints__hint' }, 'Glissez les points sur la carte pour ajuster le tracé.');

    waypointsSection.replaceChildren(
      h('div', { class: 'section__title' }, 'Parcours'),
      list,
      hint,
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--sm', type: 'button', disabled: wps.length < 2, onclick: () => trip.reverse() }, iconEl('swap', 15), 'Inverser'),
        h('button', { class: 'btn btn--sm', type: 'button', disabled: wps.length < 2, onclick: () => trip.closeLoop() }, iconEl('loop', 15), 'Boucle'),
        h(
          'button',
          {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            onclick: () => {
              if (wps.length < 3 || confirm('Effacer tout le parcours ?')) trip.clear();
            },
          },
          iconEl('trash', 15),
          'Effacer',
        ),
      ),
    );
  };

  // ——— settings ———

  const renderSettings = () => {
    const s = trip.settings;
    const profileButtons = PROFILES.map((p) =>
      h('button', { type: 'button', 'aria-pressed': String(p.id === s.profile), title: p.hint, onclick: () => trip.update({ profile: p.id }) }, p.label),
    );
    const pace = h('input', { type: 'number', min: '15', max: '200', step: '5', value: String(s.kmPerDay), inputmode: 'numeric', 'aria-label': 'Kilomètres par jour' });
    const setPace = (v: number) => trip.update({ kmPerDay: Math.max(15, Math.min(200, Math.round(v / 5) * 5)) });
    pace.addEventListener('change', () => setPace(Number(pace.value) || 60));
    const date = h('input', { class: 'input', type: 'date', value: s.startDate, 'aria-label': 'Date de départ' });
    date.addEventListener('change', () => date.value && trip.update({ startDate: date.value }));

    settingsSection.replaceChildren(
      h('div', { class: 'section__title' }, 'Réglages'),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field__label' }, 'Type de parcours'),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Type de parcours' }, profileButtons),
        h('p', { class: 'hint' }, PROFILES.find((p) => p.id === s.profile)?.hint ?? ''),
      ),
      h(
        'div',
        { class: 'field', style: 'margin-top:16px' },
        h('span', { class: 'field__label' }, 'Priorité aux véloroutes'),
        supportsPriority(s.profile)
          ? [
              h(
                'div',
                { class: 'segmented', role: 'group', 'aria-label': 'Priorité aux véloroutes' },
                PRIORITIES.map((p) =>
                  h('button', { type: 'button', 'aria-pressed': String(p.id === s.priority), title: p.hint, onclick: () => trip.update({ priority: p.id }) }, p.label),
                ),
              ),
              h('p', { class: 'hint' }, PRIORITIES.find((p) => p.id === s.priority)?.hint ?? ''),
            ]
          : h('p', { class: 'hint' }, 'Le profil « Direct » cherche le plus court chemin tranquille : il ne se règle pas.'),
      ),
      h(
        'div',
        { class: 'field-grid', style: 'margin-top:16px' },
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field__label' }, 'Rythme (km / jour)'),
          h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', 'aria-label': 'Moins', onclick: () => setPace(s.kmPerDay - 5) }, '−'),
            pace,
            h('button', { type: 'button', 'aria-label': 'Plus', onclick: () => setPace(s.kmPerDay + 5) }, '+'),
          ),
        ),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Départ le'), date),
      ),
    );
  };

  // ——— status ———

  trip.on('status', (st) => {
    statusEl.replaceChildren();
    if (st.state === 'error') {
      statusEl.append(
        h(
          'div',
          { class: 'notice notice--error', role: 'alert' },
          iconEl('info', 16),
          h('span', { class: 'notice__body' }, st.message),
          st.canRetry ? h('button', { class: 'btn btn--sm', type: 'button', onclick: () => trip.retry() }, 'Relancer') : null,
        ),
      );
    }
  });

  // ——— summary, profile & stages ———

  const renderRoute = async (route: RouteSummary | null) => {
    const token = ++renderToken;
    if (!route) {
      summarySection.replaceChildren();
      stagesSection.replaceChildren();
      stages = [];
      deps.onStages([]);
      return;
    }
    stages = splitStages(route, trip.settings.kmPerDay);
    deps.onStages(stages);
    const share = (v: number) => (route.length ? v / route.length : 0);

    const stat = (value: string, unit: string, label: string) =>
      h('div', { class: 'stat' }, h('div', { class: 'stat__value' }, value, h('span', { class: 'stat__unit' }, unit)), h('div', { class: 'stat__label' }, label));
    const meter = (label: string, fraction: number, color: string, ic: IconName) =>
      h(
        'div',
        { class: 'meter' },
        h('span', { class: 'meter__label' }, iconEl(ic, 15), label),
        h('span', { class: 'meter__value' }, fmt.percent(fraction)),
        h('span', { class: 'meter__track' }, h('span', { class: 'meter__fill', style: `width:${(fraction * 100).toFixed(1)}%;background:${color}` })),
      );

    const kmValue = route.length / 1000;
    const profileHost = h('div', { class: 'profile-host' });
    summarySection.replaceChildren(
      h('div', { class: 'section__title' }, 'Le voyage'),
      h(
        'div',
        { class: 'stats' },
        stat(kmValue < 100 ? kmValue.toFixed(1).replace('.', ',') : String(Math.round(kmValue)), 'km', 'Distance'),
        stat(String(Math.round(route.ascent)), 'm', 'Dénivelé +'),
        stat(String(stages.length), stages.length > 1 ? 'jours' : 'jour', `≈ ${fmt.duration(route.time)} en selle`),
      ),
      h(
        'div',
        { class: 'card card--pad meters' },
        meter('Sur véloroutes balisées', share(route.onCycleRoute), 'var(--map-cycle-national)', 'bike'),
        meter('En voie verte, sans voitures', share(route.carFree), 'var(--ok)', 'sparkle'),
        meter('Sur chemins non revêtus', share(route.unpaved), 'var(--warn)', 'mountain'),
      ),
      ...(route.reducedLegs
        ? [h(
            'div',
            { class: 'notice', style: 'margin-top:12px' },
            iconEl('info', 16),
            h(
              'span',
              { class: 'notice__body' },
              `Serveur de calcul chargé : ${route.reducedLegs > 1 ? `${route.reducedLegs} tronçons ont été calculés` : 'un tronçon a été calculé'} avec une priorité aux véloroutes réduite.`,
            ),
            h('button', { class: 'btn btn--sm', type: 'button', onclick: () => trip.retry() }, 'Réessayer'),
          )]
        : []),
      profileHost,
      h(
        'div',
        { class: 'btn-row btn-row--fill' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => download(`sky-trip-${trip.settings.startDate}.gpx`, toGpx(route, trip.waypoints, stages)),
          },
          iconEl('download', 16),
          'GPX',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              const url = shareUrl(trip);
              try {
                if (navigator.share && window.matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Mon voyage Sky Trip', url });
                else {
                  await navigator.clipboard.writeText(url);
                  deps.toast('Lien du voyage copié.');
                }
              } catch {
                // user cancelled
              }
            },
          },
          iconEl('link', 16),
          'Partager',
        ),
        h('button', { class: 'btn', type: 'button', onclick: () => deps.fitRoute() }, iconEl('locate', 16), 'Recentrer'),
      ),
    );

    const drawProfile = (samples: ProfileSample[] | null) => profileHost.replaceChildren(renderProfile(route, stages, samples, deps.onHover));
    drawProfile(null);
    renderStages(token);

    // Sky strip along the route (one sample every ~1/150 of the length).
    const n = Math.min(300, Math.max(20, Math.round(route.length / 1000)));
    const ds = Array.from({ length: n + 1 }, (_, i) => (route.length * i) / n);
    const readings = await skyAlong(ds.map((d) => along(route.coords, route.cum, d)));
    if (token !== renderToken) return;
    drawProfile(ds.map((d, i) => ({ d, sky: readings[i] })));
  };

  const renderStages = (token: number) => {
    const list = h('ol', { class: 'timeline' });
    stagesSection.replaceChildren(
      h('div', { class: 'section__title' }, 'Étapes & nuits', h('span', { class: 'section__aside' }, `départ ${fmt.shortDay(eveningOf(trip.settings.startDate))}`)),
      list,
    );
    const nightCards: { stage: Stage; card: HTMLElement; score: number }[] = [];

    stages.forEach((stage) => {
      const date = eveningOf(trip.settings.startDate, stage.day - 1);
      list.append(
        h(
          'li',
          { class: 'timeline__day' },
          h('span', { class: 'timeline__dot' }),
          h(
            'div',
            { class: 'timeline__head' },
            h('strong', null, `Jour ${stage.day}`),
            h('span', { class: 'timeline__date' }, fmt.shortDay(date)),
          ),
          h(
            'div',
            { class: 'timeline__meta num' },
            `${fmt.km(stage.to - stage.from)} · D+ ${Math.round(stage.ascent)} m`,
            stage.last ? ` · arrivée${trip.waypoints.at(-1)?.name ? ` à ${trip.waypoints.at(-1)!.name}` : ''}` : '',
          ),
        ),
      );
      if (stage.last) return;

      const card = h('li', { class: 'night', id: `night-${stage.day}` }, h('p', { class: 'hint' }, 'Analyse du ciel…'));
      list.append(card);
      const forecast = forecastNight(date, stage.end[0], stage.end[1]);
      Promise.all([skyAt(stage.end[0], stage.end[1]), placeName(stage.end)]).then(([sky, place]) => {
        if (token !== renderToken) return;
        const score = nightScore(sky?.sqm ?? null, forecast);
        nightCards.push({ stage, card, score });
        card.replaceChildren(...nightContent(stage, date, forecast, sky, place, score));
        markBestNight();
      });
    });

    const markBestNight = () => {
      if (nightCards.length !== stages.length - 1 || nightCards.length < 2) return;
      const best = nightCards.reduce((a, b) => (b.score > a.score ? b : a));
      best.card.classList.add('is-best');
      best.card.querySelector('.night__title')?.append(h('span', { class: 'badge badge--star' }, 'Meilleure nuit'));
    };
  };

  const nightContent = (stage: Stage, date: Date, f: NightForecast, sky: SkyReading | null, place: string | null, score: number): Node[] => {
    const q = nightQuality(score);
    const darkLine = f.noAstronomicalNight
      ? 'Pas de nuit noire complète à cette saison : le ciel reste légèrement clair.'
      : `Nuit noire de ${fmt.clock(f.darkFrom)} à ${fmt.clock(f.darkTo)}`;
    const moonless =
      f.bestWindow && f.moonlessMinutes > 0
        ? `Sans Lune : ${fmt.duration(f.moonlessMinutes * 60)}, idéalement ${fmt.clock(f.bestWindow.from)} – ${fmt.clock(f.bestWindow.to)}`
        : 'La Lune est levée toute la nuit.';
    const checkin = fmt.isoDay(date);
    return [
      h(
        'div',
        { class: 'night__head' },
        h('div', { class: 'night__title' }, iconEl('moon', 15), h('strong', null, `Nuit ${stage.day}`), h('span', { class: 'night__date' }, fmt.shortDay(date))),
        h('span', { class: `night__score tone-${q.tone}` }, q.label),
      ),
      h('p', { class: 'night__place' }, place ? `Près de ${place}` : 'Point du parcours', h('span', { class: 'num' }, ` · km ${Math.round(stage.to / 1000)}`)),
      h(
        'dl',
        { class: 'night__facts' },
        h('dt', null, 'Ciel'),
        h(
          'dd',
          null,
          sky
            ? [
                h('span', { class: 'zone-swatch', style: `background:${sky.zone.color}` }),
                `${sky.zone.label} · `,
                h('span', { class: 'num' }, `${sky.sqm.toFixed(2).replace('.', ',')} mag/″²`),
                h('span', { class: 'night__sub' }, `Voie lactée ${sky.milkyWay}`),
              ]
            : 'Donnée indisponible',
        ),
        h('dt', null, 'Lune'),
        h(
          'dd',
          null,
          moonGlyph(f.moonFraction, f.moonWaxing),
          `${Math.round(f.moonFraction * 100)} % · ${moonPhaseName(f.moonFraction, f.moonWaxing)}`,
          h('span', { class: 'night__sub' }, moonless),
        ),
        h('dt', null, 'Obscurité'),
        h('dd', null, darkLine),
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => deps.showLodgingAround(stage.end) }, iconEl('bed', 14), 'Dormir ici'),
        h(
          'a',
          { class: 'btn btn--sm btn--ghost', href: bookingSearchUrl(place ?? 'France', checkin), target: '_blank', rel: 'noopener' },
          'Booking',
          iconEl('external', 13),
        ),
        h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => deps.focus(stage.end, 12) }, 'Voir'),
      ),
    ];
  };

  // Name unnamed waypoints from the nearest locality.
  const nameWaypoints = () => {
    for (const wp of trip.waypoints) {
      if (wp.name) continue;
      placeName(wp.lngLat).then((name) => name && trip.rename(wp.id, name));
    }
  };

  trip.on('waypoints', () => {
    renderWaypoints();
    nameWaypoints();
  });
  trip.on('settings', () => {
    renderSettings();
    void renderRoute(trip.route);
  });
  trip.on('route', (route) => void renderRoute(route));

  renderWaypoints();
  renderSettings();
  nameWaypoints();
  void renderRoute(trip.route);

  return {
    scrollToNight(day: number) {
      const el = root.querySelector(`#night-${day}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('is-flash');
      setTimeout(() => el?.classList.remove('is-flash'), 1200);
    },
  };
}
