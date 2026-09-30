// Place search and reverse geocoding with Photon (komoot), built on OpenStreetMap.
import type { LngLat } from './geo';

const PHOTON = 'https://photon.komoot.io';
// Bias towards France and its neighbours.
const BBOX = '-6.5,41,10.5,51.6';

export interface Place {
  name: string;
  context: string;
  type: string;
  lngLat: LngLat;
}

const TYPE_LABELS: Record<string, string> = {
  city: 'Ville',
  town: 'Ville',
  village: 'Village',
  hamlet: 'Hameau',
  locality: 'Lieu-dit',
  station: 'Gare',
  halt: 'Gare',
  peak: 'Sommet',
  camp_site: 'Camping',
  hotel: 'Hôtel',
  observatory: 'Observatoire',
  lake: 'Lac',
  administrative: 'Commune',
  street: 'Rue',
  house: 'Adresse',
  district: 'Quartier',
  county: 'Département',
  state: 'Région',
  attraction: 'Site',
  viewpoint: 'Point de vue',
};

interface PhotonFeature {
  geometry: { coordinates: LngLat };
  properties: Record<string, string | undefined>;
}

function toPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const name = p.name ?? [p.housenumber, p.street].filter(Boolean).join(' ') ?? p.city ?? '';
  const locality = p.city ?? p.town ?? p.village ?? p.county;
  const context = [locality !== name ? locality : null, p.county !== locality ? p.county : null, p.country !== 'France' ? p.country : null]
    .filter(Boolean)
    .join(', ');
  return {
    name: name || locality || 'Lieu',
    context,
    type: TYPE_LABELS[p.osm_value ?? ''] ?? TYPE_LABELS[p.type ?? ''] ?? '',
    lngLat: f.geometry.coordinates,
  };
}

export async function searchPlaces(query: string, near?: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL(`${PHOTON}/api/`);
  url.searchParams.set('q', query);
  url.searchParams.set('lang', 'fr');
  url.searchParams.set('limit', '7');
  url.searchParams.set('bbox', BBOX);
  if (near) {
    url.searchParams.set('lon', near[0].toFixed(3));
    url.searchParams.set('lat', near[1].toFixed(3));
    url.searchParams.set('location_bias_scale', '0.3');
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data = await res.json();
  return (data.features as PhotonFeature[]).map(toPlace);
}

const reverseCache = new Map<string, Promise<string | null>>();

/** Name of the nearest locality ("Florac", "Saint-Pierre-de-Chartreuse"…). */
export function placeName(lngLat: LngLat): Promise<string | null> {
  const key = `${lngLat[0].toFixed(3)},${lngLat[1].toFixed(3)}`;
  let p = reverseCache.get(key);
  if (!p) {
    const url = `${PHOTON}/reverse?lon=${lngLat[0]}&lat=${lngLat[1]}&lang=fr&limit=1&radius=5&layer=city&layer=locality&layer=district`;
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const props = d?.features?.[0]?.properties;
        if (!props) return null;
        return props.city ?? props.town ?? props.village ?? props.name ?? props.county ?? null;
      })
      .catch(() => null);
    reverseCache.set(key, p);
  }
  return p;
}
