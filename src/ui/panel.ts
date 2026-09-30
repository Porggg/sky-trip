// The side panel (desktop) which turns into a draggable bottom sheet on phones.
import { h, svg } from '../lib/dom';
import { icon, type IconName } from './icons';

export type TabId = 'trip' | 'layers' | 'routes';
type SheetState = 'peek' | 'half' | 'full';

const MOBILE = window.matchMedia('(max-width: 760px)');
const PEEK_PX = 168;

const LOGO = `<svg class="brand__mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
  <circle cx="20" cy="20" r="18.5" stroke="currentColor" stroke-opacity=".35"/>
  <path d="M20 7.5l2.2 8.3 8.3 2.2-8.3 2.2L20 28.5l-2.2-8.3-8.3-2.2 8.3-2.2z" fill="currentColor"/>
  <circle cx="30.5" cy="10" r="1.2" fill="currentColor" fill-opacity=".7"/>
  <circle cx="10" cy="28.5" r="1" fill="currentColor" fill-opacity=".5"/>
  <path d="M6.5 31.5c6-3.2 11.5-3.6 17-1.6 3.7 1.3 6.8 1.2 10-.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

export class Panel {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private tabs = new Map<TabId, { button: HTMLButtonElement; panel: HTMLElement; count: HTMLElement }>();
  private scroll: HTMLElement;
  private current: TabId = 'trip';
  private state: SheetState = 'peek';

  constructor(parent: HTMLElement) {
    this.head = h(
      'div',
      { class: 'panel__head' },
      h(
        'div',
        { class: 'brand' },
        svg(LOGO),
        h('div', null, h('div', { class: 'brand__name' }, 'Sky Trip'), h('div', { class: 'brand__tagline' }, 'Voyages à vélo sous les étoiles')),
      ),
    );
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections' });
    this.scroll = h('div', { class: 'panel__scroll' });
    const handle = h('button', { class: 'panel__handle', type: 'button', 'aria-label': 'Agrandir ou réduire le panneau' });
    this.el = h('aside', { class: 'panel', 'aria-label': 'Préparer le voyage' }, handle, this.head, tablist, this.scroll);
    parent.appendChild(this.el);

    const defs: [TabId, string, IconName][] = [
      ['trip', 'Itinéraire', 'route'],
      ['layers', 'Calques', 'layers'],
      ['routes', 'Véloroutes', 'list'],
    ];
    for (const [id, label, ic] of defs) {
      const count = h('span', { class: 'tab__count' });
      const button = h(
        'button',
        { class: 'tab', role: 'tab', id: `tab-${id}`, 'aria-controls': `tabpanel-${id}`, 'aria-selected': 'false', tabindex: '-1', type: 'button' },
        svg(icon(ic, 16)),
        label,
        count,
      );
      button.addEventListener('click', () => this.select(id, true));
      button.addEventListener('keydown', (e) => {
        const ids = defs.map((d) => d[0]);
        const i = ids.indexOf(id);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
          this.select(next, true);
          this.tabs.get(next)!.button.focus();
        }
      });
      const panel = h('section', { class: 'tab-panel', role: 'tabpanel', id: `tabpanel-${id}`, 'aria-labelledby': `tab-${id}`, hidden: true });
      tablist.appendChild(button);
      this.scroll.appendChild(panel);
      this.tabs.set(id, { button, panel, count });
    }
    this.select('trip');
    this.setupSheet(handle, [handle, this.head, tablist]);
  }

  body(id: TabId): HTMLElement {
    return this.tabs.get(id)!.panel;
  }

  setCount(id: TabId, text: string) {
    this.tabs.get(id)!.count.textContent = text;
  }

  select(id: TabId, fromUser = false) {
    this.current = id;
    for (const [tid, t] of this.tabs) {
      const active = tid === id;
      t.button.setAttribute('aria-selected', String(active));
      t.button.tabIndex = active ? 0 : -1;
      t.panel.hidden = !active;
    }
    this.scroll.scrollTop = 0;
    if (fromUser && MOBILE.matches && this.state === 'peek') this.setState('half');
  }

  get tab() {
    return this.current;
  }

  /** On phones, makes sure the sheet shows enough content. */
  reveal(state: SheetState = 'half') {
    if (!MOBILE.matches) return;
    const order: SheetState[] = ['peek', 'half', 'full'];
    if (order.indexOf(this.state) < order.indexOf(state)) this.setState(state);
  }

  collapse() {
    if (MOBILE.matches) this.setState('peek');
  }

  // ——— bottom sheet ———

  private fullHeight() {
    return this.el.getBoundingClientRect().height;
  }

  private offsetFor(state: SheetState) {
    const full = this.fullHeight();
    const visible = state === 'peek' ? PEEK_PX : state === 'half' ? Math.round(window.innerHeight * 0.52) : full;
    return Math.max(0, full - visible);
  }

  private setState(state: SheetState) {
    this.state = state;
    this.el.dataset.sheet = state;
    this.el.style.setProperty('--sheet-offset', `${this.offsetFor(state)}px`);
  }

  private setupSheet(handle: HTMLElement, dragAreas: HTMLElement[]) {
    let startY = 0;
    let startOffset = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let dragging = false;
    let moved = false;

    const onDown = (e: PointerEvent) => {
      if (!MOBILE.matches || e.button > 0) return;
      // Let inputs and buttons inside the header work normally.
      if (e.target !== handle && (e.target as HTMLElement).closest('input, a, [role="listbox"]')) return;
      dragging = true;
      moved = false;
      startY = lastY = e.clientY;
      lastT = performance.now();
      startOffset = this.offsetFor(this.state);
      velocity = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) {
        moved = true;
        this.el.classList.add('is-dragging');
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }
      const now = performance.now();
      velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
      lastY = e.clientY;
      lastT = now;
      const offset = Math.min(this.offsetFor('peek'), Math.max(0, startOffset + dy));
      this.el.style.setProperty('--sheet-offset', `${offset}px`);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('is-dragging');
      if (!moved) return;
      const current = parseFloat(this.el.style.getPropertyValue('--sheet-offset')) || 0;
      const states: SheetState[] = ['full', 'half', 'peek'];
      let target: SheetState;
      if (Math.abs(velocity) > 0.5) {
        const i = states.indexOf(this.state);
        target = velocity > 0 ? states[Math.min(2, i + 1)] : states[Math.max(0, i - 1)];
      } else {
        target = states.reduce((best, s) => (Math.abs(this.offsetFor(s) - current) < Math.abs(this.offsetFor(best) - current) ? s : best));
      }
      this.setState(target);
      // Swallow the click that may follow a drag (on a tab, for instance).
      const swallow = (ev: Event) => ev.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 300);
    };
    for (const area of dragAreas) area.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    handle.addEventListener('click', () => {
      if (moved) return;
      this.setState(this.state === 'peek' ? 'half' : this.state === 'half' ? 'full' : 'peek');
    });

    const sync = () => {
      if (MOBILE.matches) this.setState(this.state);
      else this.el.style.removeProperty('--sheet-offset');
    };
    MOBILE.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    requestAnimationFrame(sync);
  }
}
