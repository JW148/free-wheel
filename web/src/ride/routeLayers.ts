import type { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'

/**
 * The route line and the rider's position, drawn on top of the basemap.
 *
 * Kept out of `style.ts` because these are *data* layers whose contents change constantly,
 * while the basemap style is fixed at map creation. Adding them afterwards also means they
 * sit above every basemap layer without having to reason about ordering.
 *
 * Waypoint pins are deliberately NOT here — they are DOM `Marker`s, because they need to be
 * draggable and individually tappable, which a symbol layer makes much harder.
 */

const ROUTE_SOURCE = 'route'
const POSITION_SOURCE = 'position'

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Adds the sources and layers once the style is loaded.
 *
 * Safe to call repeatedly — the map is rebuilt whenever the basemap archive changes, and the
 * caller should not have to track whether this particular instance has been set up yet.
 */
export function ensureRouteLayers(map: MapLibreMap): void {
  if (map.getSource(ROUTE_SOURCE)) return

  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: EMPTY })
  map.addSource(POSITION_SOURCE, { type: 'geojson', data: EMPTY })

  // A casing under the line, for the same reason roads have one: a bare stroke over a busy
  // basemap is hard to follow at a glance, which is the only thing that matters here.
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 12],
    },
  })
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#e8590c',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7],
    },
  })

  // The position dot goes last so it is never buried under the route it sits on.
  map.addLayer({
    id: 'position-halo',
    type: 'circle',
    source: POSITION_SOURCE,
    paint: {
      'circle-radius': 18,
      'circle-color': '#1c7ed6',
      'circle-opacity': 0.18,
    },
  })
  map.addLayer({
    id: 'position-dot',
    type: 'circle',
    source: POSITION_SOURCE,
    paint: {
      'circle-radius': 7,
      'circle-color': '#1c7ed6',
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
    },
  })
}

export function setRouteLine(map: MapLibreMap, coords: [number, number][] | null): void {
  const source = map.getSource<GeoJSONSource>(ROUTE_SOURCE)
  if (!source) return
  source.setData(
    coords && coords.length > 1
      ? {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
          ],
        }
      : EMPTY,
  )
}

export function setPosition(map: MapLibreMap, lon: number, lat: number): void {
  const source = map.getSource<GeoJSONSource>(POSITION_SOURCE)
  if (!source) return
  source.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }],
  })
}

/** Bounding box of a set of coordinates, or null if there are none. */
export function boundsOf(coords: [number, number][]): LngLatBoundsLike | null {
  if (coords.length === 0) return null
  let [west, south] = coords[0]
  let [east, north] = coords[0]
  for (const [lon, lat] of coords) {
    if (lon < west) west = lon
    if (lon > east) east = lon
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  return [
    [west, south],
    [east, north],
  ]
}
