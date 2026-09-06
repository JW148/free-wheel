import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLatBoundsLike,
  Map as MapLibreMap,
  Point,
} from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { profileById } from './profiles'

/**
 * The route lines and the rider's position, drawn on top of the basemap.
 *
 * Kept out of `style.ts` because these are *data* layers whose contents change constantly,
 * while the basemap style is fixed at map creation. Adding them afterwards also means they
 * sit above every basemap layer without having to reason about ordering.
 *
 * Waypoint pins are deliberately NOT here — they are DOM `Marker`s, because they need to be
 * draggable and individually tappable, which a symbol layer makes much harder.
 */

const ROUTE_SOURCE = 'route'
const ROUTE_LINE_LAYER = 'route-line'
const POSITION_SOURCE = 'position'

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * How a route relates to the others on screen, which is what decides how loudly it is drawn.
 *
 * - `solo` — the only route. Drawn like a chosen one, because it effectively is.
 * - `candidate` — one of several, none picked yet. All equal, all in their profile colour.
 * - `chosen` — the one the rider has committed to. Thickest, fully opaque, drawn last.
 * - `unchosen` — compared against, but not picked. Recedes without disappearing.
 */
export type RouteState = 'solo' | 'candidate' | 'chosen' | 'unchosen'

export interface DrawnRoute {
  /** The profile id. Carried onto the feature so a tap can name what it hit. */
  id: string
  coords: [number, number][]
  colour: string
  state: RouteState
}

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
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, byState(7, 6, 5), 16, byState(13, 11, 9)],
    },
  })
  map.addLayer({
    id: ROUTE_LINE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      // An unchosen route recedes but stays visible: it is the thing the choice was made
      // against, and it is still what you tap to change your mind. Tuned by looking: 0.32
      // read as gone rather than quiet over the dark basemap, and 0.45 was still faint at
      // overview zoom, where the line is only 2.5px. The chosen route is already separated by
      // width and by being drawn on top, so it does not need the others turned down this far.
      'line-opacity': [
        'match',
        ['get', 'state'],
        'unchosen',
        0.55,
        'candidate',
        0.88,
        1,
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, byState(4, 3.4, 2.5), 16, byState(8, 6.8, 5)],
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

/**
 * A width per route state, for use as one stop of a zoom `interpolate`.
 *
 * `zoom` has to be the input to the *top-level* expression — nesting it inside a `match` is a
 * style validation error, and MapLibre reports that as an `error` event rather than throwing,
 * so the map silently never loads.
 */
function byState(
  chosen: number,
  candidate: number,
  unchosen: number,
): ExpressionSpecification {
  return ['match', ['get', 'state'], 'unchosen', unchosen, 'candidate', candidate, chosen]
}

/**
 * Decides how each computed route should be drawn.
 *
 * Pure, and separate from `setRoutes`, because this is the whole visual grammar of the
 * comparison: which line is loud and which recedes.
 *
 * Every route is drawn in its profile's colour, including a lone one. A lone route used to be
 * drawn near-white on the grounds that hue is only for telling routes apart — but that colour
 * was ΔE 4.4 from the light basemap's buildings, so the most common case in the app was also
 * its least visible line. Using the profile colour throughout also means the map does not
 * repaint the moment a second profile is ticked.
 */
export function drawnRoutes(
  routes: Record<string, { coords: [number, number][] }>,
  chosen: string | null,
): DrawnRoute[] {
  const ids = Object.keys(routes)
  const solo = ids.length === 1
  // A choice pointing at a route that is no longer computed is not a choice. Without this a
  // stale id would dim every line on screen and highlight none of them.
  const live = chosen && routes[chosen] ? chosen : null

  return ids.map((id) => ({
    id,
    coords: routes[id].coords,
    colour: profileById(id).colour,
    state: solo ? 'solo' : live === null ? 'candidate' : id === live ? 'chosen' : 'unchosen',
  }))
}

/**
 * Builds the feature collection for the route source.
 *
 * One source with the state and colour carried as feature properties, rather than a layer per
 * profile: comparing profiles means the set changes as you tick boxes, and adding and removing
 * layers on a live map is both slower and much easier to get wrong than replacing the data.
 *
 * The chosen route is appended last. Within a layer MapLibre draws in feature order, so that
 * puts the route you are actually going to ride on top of the ones you rejected.
 */
export function routeFeatures(routes: DrawnRoute[]): FeatureCollection {
  const ordered = [...routes].sort(
    (a, b) => Number(a.state === 'chosen') - Number(b.state === 'chosen'),
  )
  return {
    type: 'FeatureCollection',
    features: ordered
      .filter((route) => route.coords.length > 1)
      .map((route) => ({
        type: 'Feature',
        properties: { profile: route.id, colour: route.colour, state: route.state },
        geometry: { type: 'LineString', coordinates: route.coords },
      })),
  }
}

export function setRoutes(map: MapLibreMap, routes: DrawnRoute[]): void {
  map.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeFeatures(routes))
}

/**
 * Rings, in screen pixels, searched outwards for a route under a tap.
 *
 * A route line is 2.5–8px wide, which is nowhere near a thumb. Growing the search rather than
 * using one fat radius means an exact tap on one of two parallel lines still resolves to the
 * one actually touched, instead of whichever happens to come back first from a 20px box.
 */
const HIT_RINGS = [4, 11, 20]

/**
 * The profile whose line is under a tap, or `null` for open map.
 *
 * MapLibre does not promise an order when several features fall in the same query box, so
 * where two routes overlap within a ring this picks one of them arbitrarily. That is why the
 * comparison list is also tappable: parallel routes a few pixels apart are exactly the case
 * where pointing at the map is a bad way to be precise.
 */
export function routeAt(map: MapLibreMap, point: Point): string | null {
  if (!map.getLayer(ROUTE_LINE_LAYER)) return null
  for (const ring of HIT_RINGS) {
    const hits = map.queryRenderedFeatures(
      [
        [point.x - ring, point.y - ring],
        [point.x + ring, point.y + ring],
      ],
      { layers: [ROUTE_LINE_LAYER] },
    )
    for (const hit of hits) {
      const profile = hit.properties?.profile
      if (typeof profile === 'string') return profile
    }
  }
  return null
}

/**
 * What a tap on the map means.
 *
 * Four intents compete for one gesture, so the order is the whole design:
 *
 * 1. **Choose** — a tap that lands on a route line always means "this one". Dropping a
 *    waypoint on the line you were pointing at would reroute the thing you were selecting.
 * 2. **Clear** — a tap on empty map reverts a choice before it edits the route. The pin
 *    toggle is on by default, so the other order would make the gesture unreachable exactly
 *    when it is wanted; a via point that really was intended costs one more tap.
 * 3. **Place** — only once there is nothing to choose and nothing to revert.
 *
 * Pure, and separate from the handler, because this is the part with branches worth testing.
 */
export type MapTap =
  | { do: 'choose'; profile: string }
  | { do: 'clear' }
  | { do: 'place' }
  | { do: 'nothing' }

export function mapTapAction(input: {
  /** The route under the tap, from {@link routeAt}. */
  profileUnderTap: string | null
  /** Whether choosing is possible at all. False while riding: the decision is made. */
  choosing: boolean
  /**
   * Whether a choice exists that is worth reverting.
   *
   * False for a lone route — that is not a comparison, there is no all-colours state to go
   * back to, and clearing would only strip the stats rail and disable Start.
   */
  clearableChoice: boolean
  placing: boolean
}): MapTap {
  const { profileUnderTap, choosing, clearableChoice, placing } = input
  if (choosing && profileUnderTap) return { do: 'choose', profile: profileUnderTap }
  if (choosing && clearableChoice) return { do: 'clear' }
  if (placing) return { do: 'place' }
  return { do: 'nothing' }
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
