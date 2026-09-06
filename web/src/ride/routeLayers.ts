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
      // A dark casing on a dark map: the route needs separating from the road under it, and
      // a white halo would glare. This reads as a shadow rather than an outline.
      'line-color': '#06141b',
      'line-opacity': 0.55,
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['case', ['get', 'focused'], 7, 5],
        16,
        ['case', ['get', 'focused'], 13, 9],
      ],
    },
  })
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      // An unfocused route is thinner and slightly translucent, so several can overlap
      // without the map turning to soup while the focused one stays unambiguous.
      'line-opacity': ['case', ['get', 'focused'], 1, 0.75],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['case', ['get', 'focused'], 4, 2.5],
        16,
        ['case', ['get', 'focused'], 8, 5],
      ],
    },
  })

  // The position dot goes last so it is never buried under the route it sits on.
  map.addLayer({
    id: 'position-halo',
    type: 'circle',
    source: POSITION_SOURCE,
    paint: {
      'circle-radius': 18,
      'circle-color': '#9ba8ab',
      'circle-opacity': 0.22,
    },
  })
  map.addLayer({
    id: 'position-dot',
    type: 'circle',
    source: POSITION_SOURCE,
    paint: {
      'circle-radius': 7,
      'circle-color': '#4a86c4',
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ccd0cf',
    },
  })
}

export interface DrawnRoute {
  id: string
  coords: [number, number][]
  colour: string
  /** The one whose stats are on screen. Drawn thicker and on top. */
  focused: boolean
}

/**
 * Draws every computed route at once.
 *
 * One source with the colour carried as a feature property, rather than a layer per profile:
 * comparing profiles means the set changes as you tick boxes, and adding and removing layers
 * on a live map is both slower and much easier to get wrong than replacing the data.
 *
 * The focused route is appended last. Within a layer MapLibre draws in feature order, so
 * that puts the route you are actually reading on top of the ones you are comparing it
 * against.
 */
export function setRoutes(map: MapLibreMap, routes: DrawnRoute[]): void {
  const source = map.getSource<GeoJSONSource>(ROUTE_SOURCE)
  if (!source) return

  const ordered = [...routes].sort((a, b) => Number(a.focused) - Number(b.focused))
  source.setData({
    type: 'FeatureCollection',
    features: ordered
      .filter((route) => route.coords.length > 1)
      .map((route) => ({
        type: 'Feature',
        properties: { colour: route.colour, focused: route.focused },
        geometry: { type: 'LineString', coordinates: route.coords },
      })),
  })
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
