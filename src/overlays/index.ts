import { Emitter } from '../lib/emitter';
import { cycleRoutesOverlay } from './cycleRoutes';
import { lightPollutionOverlay } from './lightPollution';
import { lodgingOverlay } from './lodging';
import { stationsOverlay } from './stations';
import type { AppContext, Overlay } from './types';

/** Overlays in the order they appear in the "Calques" tab. Add new ones here. */
export function createOverlays() {
  const cycleRoutes = cycleRoutesOverlay();
  const list: Overlay[] = [cycleRoutes, stationsOverlay(), lightPollutionOverlay(), lodgingOverlay()];
  return { list, cycleRoutes };
}

const STORAGE_KEY = 'sky-trip:overlays';

export class OverlayManager extends Emitter<{ visibility: { id: string; visible: boolean } }> {
  private visible = new Map<string, boolean>();
  private ready = false;

  constructor(readonly overlays: Overlay[]) {
    super();
    let saved: Record<string, boolean> = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      saved = {};
    }
    for (const o of overlays) this.visible.set(o.id, saved[o.id] ?? o.defaultVisible);
  }

  async init(ctx: AppContext) {
    // Overlays are independent: one failing (network, data) must not block the others.
    await Promise.all(
      this.overlays.map(async (o) => {
        try {
          await o.init(ctx);
          o.setVisible(this.isVisible(o.id));
        } catch (err) {
          console.error(`Calque « ${o.title} » indisponible`, err);
        }
      }),
    );
    this.ready = true;
  }

  isVisible(id: string) {
    return this.visible.get(id) ?? false;
  }

  setVisible(id: string, visible: boolean) {
    const overlay = this.overlays.find((o) => o.id === id);
    if (!overlay || this.isVisible(id) === visible) return;
    this.visible.set(id, visible);
    if (this.ready) overlay.setVisible(visible);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.visible)));
    } catch {
      // ignore
    }
    this.emit('visibility', { id, visible });
  }

  /** Interactive layers of visible overlays, points above lines. */
  interactiveLayers(): { overlay: Overlay; layer: string }[] {
    const order = { points: 0, route: 1, network: 2, sky: 3 };
    return this.overlays
      .filter((o) => this.isVisible(o.id) && o.interactiveLayers?.length)
      .sort((a, b) => order[a.slot] - order[b.slot])
      .flatMap((o) => o.interactiveLayers!.map((layer) => ({ overlay: o, layer })));
  }
}
