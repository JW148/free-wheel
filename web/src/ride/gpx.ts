/**
 * Reads BRouter's GPX into something the map can draw.
 *
 * ## Why parse GPX rather than ask the engine for GeoJSON
 *
 * `brouter-core` has a `FormatJson` that would hand back GeoJSON directly, which is the more
 * obvious route. It is not used, because taking it means adding a second export to
 * `Router.java` and rebuilding the Wasm — and the GPX corpus is the project's regression net.
 * Every route the app draws goes through the *same* `FormatGpx` output that is checked
 * byte-for-byte against the JVM, so what you see on the map is provably what the parity test
 * covers. A second output format would be a second thing to keep honest.
 *
 * ## Why regexes and not DOMParser
 *
 * The input is never arbitrary GPX — it is always `FormatGpx`'s own output, whose shape is
 * fixed and one track point per line. Regexes let this run unchanged in a Worker (no DOM),
 * parse in plain Node under test, and avoid building a 5,000-node document for a 76 km route
 * only to throw it away. The trade is that this is coupled to `FormatGpx`; the fixtures under
 * `__fixtures__/` are verbatim engine output so that coupling breaks loudly rather than
 * silently.
 *
 * If we ever need to read GPX the app did not produce — an imported route from elsewhere —
 * that is a different function, and it should use a real parser.
 */

import { filteredAscentM } from './ascent'
import { haversineM } from './geo'

export interface ParsedRoute {
  /** `[lon, lat]` pairs in GeoJSON order, ready to become a LineString. */
  coords: [number, number][]
  /** Metres, parallel to {@link coords}. Zero where the GPX carried no `<ele>`. */
  elevations: number[]
  /** Track length in metres, from BRouter's own summary rather than recomputed. */
  distanceM: number
  /** Filtered ascent in metres — the figure BRouter considers meaningful. */
  ascendM: number
  /**
   * Estimated ride time in seconds, or `null` when the profile has no energy model.
   *
   * `shortest.brf` has none, so BRouter emits no `time=` at all. Reporting zero would be a
   * lie the UI would render as "0 min"; null lets it say nothing instead.
   */
  timeS: number | null
  name: string | null
}

/**
 * BRouter's summary line, e.g.
 * `track-length = 1964 filtered ascend = 1 plain-ascend = -2 cost=2975 energy=.0kwh time=5m 23s`
 *
 * `filtered ascend` and `plain-ascend` are different numbers and the second can be negative;
 * matching them separately keeps them from being mixed up.
 */
const SUMMARY = /track-length\s*=\s*(-?\d+)\s+filtered ascend\s*=\s*(-?\d+)/
const TIME = /\btime=(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/

const TRKPT = /<trkpt\b([^>]*)>(?:\s*<ele>([-\d.]+)<\/ele>)?/g
const LON = /\blon="(-?[\d.]+)"/
const LAT = /\blat="(-?[\d.]+)"/
const TRACK_NAME = /<name>([^<]*)<\/name>/

/**
 * The track points, in order, with a height per point.
 *
 * Shared by both parsers because it is the one thing the two documents agree about: a
 * computed route and a recorded ride differ entirely in their summaries and not at all in
 * the shape of a `<trkpt>`.
 */
function trackPoints(gpx: string): { coords: [number, number][]; elevations: number[] } {
  const coords: [number, number][] = []
  const elevations: number[] = []

  for (const match of gpx.matchAll(TRKPT)) {
    const [, attributes, ele] = match
    const lon = LON.exec(attributes)
    const lat = LAT.exec(attributes)
    if (!lon || !lat) continue
    coords.push([Number(lon[1]), Number(lat[1])])
    elevations.push(ele === undefined ? 0 : Number(ele))
  }

  return { coords, elevations }
}

export function parseBrouterGpx(gpx: string): ParsedRoute {
  // `Router.route` reports failure by returning a string, not by throwing, so this is a
  // shape a caller can genuinely hand us. Parsing on would yield an empty route and draw
  // nothing, which looks like a routing success with no road.
  if (gpx.startsWith('error:')) throw new Error(gpx.slice('error:'.length).trim())

  const { coords, elevations } = trackPoints(gpx)

  if (coords.length === 0) {
    throw new Error('the route came back with no track points')
  }

  const summary = SUMMARY.exec(gpx)
  const time = TIME.exec(gpx)

  return {
    coords,
    elevations,
    distanceM: summary ? Number(summary[1]) : 0,
    ascendM: summary ? Number(summary[2]) : 0,
    timeS: time ? Number(time[1] ?? 0) * 3600 + Number(time[2] ?? 0) * 60 + Number(time[3] ?? 0) : null,
    name: TRACK_NAME.exec(gpx)?.[1] ?? null,
  }
}

/**
 * Whether a parsed track carries real heights at all.
 *
 * False for a recorded ride with no route behind it, and the reason everything downstream of
 * elevation has to be able to say "cannot answer". `RouteGeometry.hasElevation` is the same
 * question asked of the built geometry; this is the one the UI asks of a route it has not
 * built a geometry for yet.
 */
export const hasHeights = (route: ParsedRoute): boolean =>
  route.elevations.some((e) => e !== 0)

/** `2.0 km` / `940 m` — a rider reads one of those at a glance and not the other. */
export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`
}

/** `5 min` / `2h 05m`, or an em dash when the profile gave us no estimate. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Reads a *recorded* track back — one of our own `traceToGpx` documents.
 *
 * Separate from {@link parseBrouterGpx} rather than a flag on it, because the two documents
 * disagree about everything except the track points. A recorded ride carries no
 * `track-length` summary and no `time=`, so `parseBrouterGpx` reports a route of zero length
 * that the progress bar then divides by; and its `<ele>` values are present only for the
 * stretches where the app had a route to take a height from, which is the whole reason
 * `RouteGeometry.hasElevation` exists.
 *
 * Distance is therefore *measured* here rather than read. That is the one figure BRouter
 * normally hands over, and summing the trace is the only way to get it — the trace is thinned
 * to 10 m, so the sum is a slight underestimate of the road but well inside what GPS knows.
 *
 * Still regexes, and still for the reason at the top of this file: this is our own output,
 * one point per line, and it has to parse in a Worker and in plain Node. Foreign GPX is a
 * different problem and still wants a real parser.
 */
export function parseTrackGpx(gpx: string): ParsedRoute {
  const { coords, elevations } = trackPoints(gpx)

  if (coords.length < 2) {
    throw new Error('that recorded ride has no track to follow')
  }

  let distanceM = 0
  for (let i = 1; i < coords.length; i++) distanceM += haversineM(coords[i - 1], coords[i])

  // Ascent is summed here rather than read, with the same deadband and the same function the
  // route geometry uses — so a loaded track's "climbing" figure and its climb list cannot
  // disagree. It is zero for a ride recorded with no route to take heights from, which is
  // correct: there is nothing to sum, and `hasHeights` is how the UI knows not to imply
  // otherwise.
  return {
    coords,
    elevations,
    distanceM,
    ascendM: filteredAscentM(elevations),
    timeS: null,
    name: TRACK_NAME.exec(gpx)?.[1] ?? null,
  }
}
