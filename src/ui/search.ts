// Place search box with keyboard-navigable suggestions (Photon).
import { h, svg } from '../lib/dom';
import { searchPlaces, type Place } from '../lib/geocode';
import type { LngLat } from '../lib/geo';
import { icon } from './icons';

export function createSearch(onPick: (place: Place) => void, near: () => LngLat): HTMLElement {
  const input = h('input', {
    class: 'input search__input',
    type: 'search',
    placeholder: 'Chercher une ville, une gare, un sommet…',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'search-results',
    'aria-label': 'Rechercher un lieu',
  });
  const list = h('ul', { class: 'search__results', id: 'search-results', role: 'listbox', hidden: true });
  const clearBtn = h('button', { class: 'search__clear', type: 'button', 'aria-label': 'Effacer la recherche', hidden: true });
  clearBtn.appendChild(svg(icon('close', 16)));
  const root = h('div', { class: 'search' }, svg(icon('search', 17)), input, clearBtn, list);
  root.firstElementChild!.classList.add('search__icon');

  let results: Place[] = [];
  let active = -1;
  let timer: number | undefined;
  let controller: AbortController | null = null;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const render = () => {
    list.replaceChildren();
    if (!results.length) {
      list.appendChild(h('li', { class: 'search__empty' }, 'Aucun lieu trouvé.'));
    }
    results.forEach((place, i) => {
      const item = h(
        'li',
        { class: 'search__result', role: 'option', id: `search-opt-${i}`, 'aria-selected': String(i === active) },
        h('span', null, h('span', { class: 'search__result-name' }, place.name), place.context ? h('span', { class: 'search__result-context' }, place.context) : null),
        place.type ? h('span', { class: 'search__result-type' }, place.type) : null,
      );
      item.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pick(i);
      });
      list.appendChild(item);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `search-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const pick = (i: number) => {
    const place = results[i];
    if (!place) return;
    input.value = place.name;
    close();
    input.blur();
    onPick(place);
  };

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = window.setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        results = await searchPlaces(q, near(), controller.signal);
        active = results.length ? 0 : -1;
        render();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          results = [];
          list.replaceChildren(h('li', { class: 'search__empty' }, 'Recherche indisponible pour le moment.'));
          list.hidden = false;
        }
      }
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(Math.max(0, active));
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    close();
    input.focus();
  });
  return root;
}
