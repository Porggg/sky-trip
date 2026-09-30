// The "Véloroutes" tab: searchable list of EuroVelo, national, regional and local routes
// and named greenways.
import { h } from '../lib/dom';
import { loadCycleIndex, routeBadge, NETWORK_LABELS, NET_RANK, type CycleRoute, type CycleRoutesOverlay } from '../overlays/cycleRoutes';

const PAGE = 60;

// Words that differ between how AF3V, signs and OpenStreetMap name the same route.
const STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'et', 'en', 'par', 'sur', 'the']);

function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

interface Searchable {
  route: CycleRoute;
  /** Tokens of the main name + ref, then of each alias. */
  names: string[][];
}

/**
 * Share of query words found (as word prefixes) in the route's best-matching name,
 * and which alias matched — so "vallée de l'Eure à vélo" finds the V41 whose greenway
 * is called "Voie verte de la vallée de l'Eure".
 */
function score(item: Searchable, query: string[]): { score: number; alias: number; closeness: number } {
  let best = { score: 0, alias: -1, closeness: 0 };
  item.names.forEach((words, index) => {
    const hits = query.filter((q) => words.some((w) => w.startsWith(q))).length / query.length;
    if (hits > best.score) best = { score: hits, alias: index - 1, closeness: Math.min(1, query.length / words.length) };
  });
  return best;
}

export function createRoutesCatalog(root: HTMLElement, overlay: CycleRoutesOverlay, onPick: () => void, setCount: (n: string) => void) {
  const query = h('input', { class: 'input', type: 'search', placeholder: 'Loire à Vélo, V80, vallée de l’Eure…', 'aria-label': 'Rechercher une véloroute' });
  const nets = new Set<CycleRoute['network']>(['icn', 'ncn']);
  const listEl = h('ol', { class: 'route-list' });
  const countEl = h('p', { class: 'hint' });
  const more = h('button', { class: 'btn btn--block', type: 'button', hidden: true }, 'Afficher plus');
  let items: Searchable[] = [];
  let shown = PAGE;
  let selected: number | null = null;

  const chip = (group: CycleRoute['network'][], label: string) => {
    const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(nets.has(group[0])) }, label);
    c.addEventListener('click', () => {
      const on = !nets.has(group[0]);
      group.forEach((n) => (on ? nets.add(n) : nets.delete(n)));
      c.setAttribute('aria-pressed', String(on));
      shown = PAGE;
      render();
    });
    return c;
  };

  /** With a query, the whole network is searched (chips only sort the browsing view). */
  const results = (): { route: CycleRoute; alias?: string }[] => {
    const q = tokens(query.value);
    if (!q.length) return items.filter((it) => nets.has(it.route.network)).map((it) => ({ route: it.route }));
    const scored = items
      .map((it) => ({ it, ...score(it, q) }))
      .filter((s) => s.score > 0);
    const top = Math.max(0, ...scored.map((s) => s.score));
    // Keep full matches, or the best partial ones when nothing matches every word.
    return scored
      .filter((s) => s.score === top && s.score >= 0.5)
      // Main-name matches first, then the bigger networks, names closest to the query, longest routes.
      .sort(
        (a, b) =>
          Number(a.alias >= 0) - Number(b.alias >= 0) ||
          NET_RANK[b.it.route.network] - NET_RANK[a.it.route.network] ||
          b.closeness - a.closeness ||
          b.it.route.km - a.it.route.km,
      )
      .map((s) => ({ route: s.it.route, alias: s.alias >= 0 ? s.it.route.aka![s.alias] : undefined }));
  };

  const render = () => {
    const found = results();
    const searching = tokens(query.value).length > 0;
    countEl.textContent = searching
      ? `${found.length} résultat${found.length > 1 ? 's' : ''} dans tout le réseau`
      : `${found.length} itinéraire${found.length > 1 ? 's' : ''}`;
    listEl.replaceChildren(
      ...found.slice(0, shown).map(({ route: r, alias }) => {
        const item = h(
          'li',
          null,
          h(
            'button',
            { class: `route-item${selected === r.i ? ' is-selected' : ''}`, type: 'button', 'aria-pressed': String(selected === r.i) },
            h(
              'span',
              { class: 'route-item__main' },
              h('span', { class: 'route-item__name' }, routeBadge(r), r.name),
              h('span', { class: 'route-item__meta' }, NETWORK_LABELS[r.network]),
              alias ? h('span', { class: 'route-item__alias' }, `Aussi : ${alias}`) : null,
            ),
            h(
              'span',
              { class: 'route-item__figures' },
              h('span', { class: 'num' }, `${r.km} km`),
              h('span', { class: 'route-item__green', title: 'Part en voie verte' }, h('span', { style: `width:${Math.round(r.greenway * 100)}%` })),
            ),
          ),
        );
        item.firstElementChild!.addEventListener('click', () => {
          selected = selected === r.i ? null : r.i;
          overlay.highlight(selected === null ? null : r);
          render();
          if (selected !== null) onPick();
        });
        return item;
      }),
    );
    if (searching && !found.length) {
      listEl.append(
        h('li', { class: 'hint' }, 'Aucune véloroute de ce nom dans OpenStreetMap. Essayez un autre mot (ville, rivière, numéro V…).'),
      );
    }
    more.hidden = found.length <= shown;
  };

  query.addEventListener('input', () => {
    shown = PAGE;
    render();
  });
  more.addEventListener('click', () => {
    shown += PAGE;
    render();
  });

  root.append(
    h(
      'div',
      { class: 'section' },
      h('p', { class: 'catalog-intro' }, 'Le réseau des véloroutes et voies vertes, tel que recensé par l’AF3V et cartographié dans OpenStreetMap.'),
      query,
      h(
        'div',
        { class: 'chips', style: 'margin-top:10px' },
        chip(['icn'], 'EuroVelo'),
        chip(['ncn'], 'Nationales'),
        chip(['rcn'], 'Régionales'),
        chip(['lcn', 'vv'], 'Locales & voies vertes'),
      ),
    ),
    h('div', { class: 'section' }, countEl, listEl, more),
  );

  listEl.append(h('li', { class: 'hint' }, 'Chargement…'));
  loadCycleIndex()
    .then((routes) => {
      items = routes
        .filter((r) => !r.generic)
        .map((route) => ({ route, names: [tokens(`${route.ref} ${route.name}`), ...(route.aka ?? []).map(tokens)] }));
      setCount(String(items.length));
      render();
    })
    .catch(() => listEl.replaceChildren(h('li', { class: 'notice notice--error' }, 'Liste des véloroutes indisponible.')));
}
