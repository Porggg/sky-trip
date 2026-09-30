import { escapeHtml } from '../lib/dom';
import type { Stage } from './stages';
import type { RouteSummary, Waypoint } from './trip';

export function toGpx(route: RouteSummary, waypoints: Waypoint[], stages: Stage[], name = 'Sky Trip'): string {
  const wpt = (lng: number, lat: number, label: string, sym: string) =>
    `  <wpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><name>${escapeHtml(label)}</name><sym>${sym}</sym></wpt>`;
  const points = route.coords
    .map(([lng, lat, ele]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`)
    .join('\n');
  const marks = [
    ...waypoints.map((w, i) => wpt(w.lngLat[0], w.lngLat[1], w.name ?? `Point ${i + 1}`, 'Flag')),
    ...stages.filter((s) => !s.last).map((s) => wpt(s.end[0], s.end[1], `Nuit ${s.day}`, 'Campground')),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sky Trip" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeHtml(name)}</name></metadata>
${marks.join('\n')}
  <trk>
    <name>${escapeHtml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

export function download(filename: string, content: string, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
