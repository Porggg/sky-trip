// Draws the planned trip: the routed line, draggable waypoint markers and night stops.
import * as maplibregl from 'maplibre-gl';
import { SLOTS } from './createMap';
import { h } from '../lib/dom';
import { icon } from '../ui/icons';
import type { LngLat } from '../lib/geo';
import type { RouteSummary, Trip, Waypoint } from '../route/trip';
import type { Stage } from '../route/stages';

const SOURCE = 'trip-route';
const HOVER_SOURCE = 'trip-hover';

export function waypointLabel(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

export class RouteLayer {
  private markers = new Map<string, maplibregl.Marker>();
  private nightMarkers: maplibregl.Marker[] = [];

  constructor(
    private map: maplibregl.Map,
    private trip: Trip,
    private onNightClick: (stage: Stage) => void,
  ) {
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource(HOVER_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer(
      {
        id: 'trip-casing',
        type: 'line',
        source: SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2b1c05', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 9, 16, 13] },
      },
      SLOTS.route,
    );
    map.addLayer(
      {
        id: 'trip-line',
        type: 'line',
        source: SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f5a524', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.6, 12, 5, 16, 8] },
      },
      SLOTS.route,
    );
    map.addLayer(
      {
        id: 'trip-hover',
        type: 'circle',
        source: HOVER_SOURCE,
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#2b1c05',
          'circle-stroke-width': 2.5,
        },
      },
      SLOTS.points,
    );

    trip.on('waypoints', (wps) => this.syncMarkers(wps));
    trip.on('route', (route) => this.setRoute(route));
    this.syncMarkers(trip.waypoints);
    if (trip.route) this.setRoute(trip.route);
  }

  private setRoute(route: RouteSummary | null) {
    const source = this.map.getSource(SOURCE) as maplibregl.GeoJSONSource;
    source.setData({
      type: 'FeatureCollection',
      features: route ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: {} }] : [],
    });
  }

  private syncMarkers(waypoints: Waypoint[]) {
    const seen = new Set<string>();
    waypoints.forEach((wp, i) => {
      seen.add(wp.id);
      const last = i === waypoints.length - 1 && waypoints.length > 1;
      let marker = this.markers.get(wp.id);
      if (!marker) {
        // MapLibre positions the outer element with a CSS transform and owns its classes,
        // so all styling (and hover effects) live on the inner badge.
        const el = h('div', { class: 'wp-marker-anchor' }, h('div', { class: 'wp-marker', role: 'img' }));
        marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat(wp.lngLat).addTo(this.map);
        marker.on('dragend', () => {
          const p = marker!.getLngLat();
          this.trip.move(wp.id, [p.lng, p.lat]);
        });
        this.markers.set(wp.id, marker);
      } else {
        marker.setLngLat(wp.lngLat);
      }
      const el = marker.getElement().firstElementChild as HTMLElement;
      el.className =`wp-marker${i === 0 ? ' is-start' : ''}${last ? ' is-end' : ''}`;
      el.textContent = waypointLabel(i);
      el.setAttribute('aria-label', `${i === 0 ? 'Départ' : last ? 'Arrivée' : `Étape ${i}`}${wp.name ? ` : ${wp.name}` : ''}`);
      el.title = `${wp.name ?? 'Point'} — glisser pour déplacer`;
    });
    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
  }

  setNights(stages: Stage[]) {
    this.nightMarkers.forEach((m) => m.remove());
    this.nightMarkers = stages
      .filter((s) => !s.last)
      .map((stage) => {
        const button = h(
          'button',
          { class: 'night-marker', type: 'button', 'aria-label': `Nuit ${stage.day}`, title: `Nuit ${stage.day}` },
          h('span', { class: 'night-marker__icon' }),
          h('span', { class: 'night-marker__label' }, String(stage.day)),
        );
        button.querySelector('.night-marker__icon')!.innerHTML = icon('moon', 13);
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onNightClick(stage);
        });
        const el = h('div', { class: 'night-marker-anchor' }, button);
        return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(stage.end).addTo(this.map);
      });
  }

  showHover(point: LngLat | null) {
    (this.map.getSource(HOVER_SOURCE) as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: point ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }] : [],
    });
  }
}
