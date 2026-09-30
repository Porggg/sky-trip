import type * as maplibregl from 'maplibre-gl';
import type { BasemapId, Slot } from '../map/createMap';
import type { Trip, Waypoint } from '../route/trip';
import type { IconName } from '../ui/icons';
import type { LngLat } from '../lib/geo';

/** Services the app offers to every overlay. */
export interface AppContext {
  map: maplibregl.Map;
  trip: Trip;
  /** Shows a popup anchored on the map. */
  openPopup(lngLat: LngLat, content: HTMLElement): void;
  closePopup(): void;
  /** "Départ / Étape / Arrivée" buttons for a place. */
  placeActions(lngLat: LngLat, meta: Partial<Waypoint>): HTMLElement;
  toast(message: string): void;
  /** Current basemap, so overlays can adapt their colours. */
  basemap(): BasemapId;
  onBasemapChange(handler: (id: BasemapId) => void): void;
  /** Lets an overlay turn another one on (e.g. "show lodging around this night"). */
  setOverlayVisible(id: string, visible: boolean): void;
}

/**
 * A thematic layer of the map. To add a new one (weather, water points, dark-sky
 * reserves…), implement this interface and register it in `overlays/index.ts`.
 */
export interface Overlay {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  /** Stacking band on the map. */
  slot: Slot;
  defaultVisible: boolean;
  /** Called once when the map style is ready. Should add sources and (hidden) layers. */
  init(ctx: AppContext): void | Promise<void>;
  setVisible(visible: boolean): void;
  /** Layers that react to clicks, top-most first. */
  interactiveLayers?: string[];
  /** Popup content for a clicked feature of one of `interactiveLayers`. */
  popupFor?(feature: maplibregl.MapGeoJSONFeature, lngLat: LngLat): HTMLElement | null;
  /** Legend, filters and options shown under the overlay's switch. */
  renderControls?(): HTMLElement;
  /** Short live status ("Zoomez pour afficher…"), shown under the title. */
  onStatus?(handler: (status: string) => void): void;
}
