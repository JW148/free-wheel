import { haversineM } from './geo'
import type { ParsedRoute } from './gpx'

/**
 * Where the rider is *on the route*, rather than where they are on the earth.
 *
 * Everything the ride screen wants to say — how far is left, when you will arrive, what the
 * gradient is under the wheels, whether you have come off the route — is a function of one
 * number: distance along the polyline. So this module computes that number and nothing else
 * depends on a map, a fix, or React.
 *
 * ## Why snapping, and not just "distance to the finish"
 *
 * Air distance to the last waypoint is wrong in the two situations that matter. It shrinks
 * while you ride *away* from the finish along a valley, and it stops shrinking on a switchback
 * where you are making excellent progress. A rider reads a number that disagrees with the road
 * and stops trusting the screen. Distance along the line always agrees with the road, because
 * it *is* the road.
 *
 * ## Why a local flat projection
 *
 * Snapping is a per-segment point-to-line projection, and doing that on a sphere means either
 * great-circle cross-track formulas per segment or a projection. Segments here are a few tens
 * of metres, so an equirectangular projection about the query point is accurate to far better
 * than a GPS fix and is a handful of multiplies. Cumulative *distances* still come from
 * {@link haversineM}, because those accumulate over 100 km and the error would not stay small.
 */

const EARTH_R = 6_371_000
const DEG = Math.PI / 180

export interface RouteGeometry {
  coords: [number, number][]
  /** Metres from the start at each coordinate. Same length as {@link coords}. */
  cumulativeM: number[]
  /** Metres of *climbing* done by each coordinate — descent contributes nothing. */
  cumulativeAscentM: number[]
  elevations: number[]
  totalM: number
}

/**
 * Precomputes everything that is a function of the route alone.
 *
 * Built once per route and reused for every fix. A 76 km route is ~5,000 points, and redoing
 * 5,000 haversines at 1 Hz for the length of a ride is the kind of waste that shows up as a
 * warm phone and a flat battery, which on this app is a correctness problem rather than a
 * performance one.
 *
 * Returns `null` for a route with nothing to travel along.
 */
export function routeGeometry(route: ParsedRoute): RouteGeometry | null {
  if (route.coords.length < 2) return null

  const cumulativeM = new Array<number>(route.coords.length)
  const cumulativeAscentM = new Array<number>(route.coords.length)
  cumulativeM[0] = 0
  cumulativeAscentM[0] = 0

  for (let i = 1; i < route.coords.length; i++) {
    cumulativeM[i] = cumulativeM[i - 1] + haversineM(route.coords[i - 1], route.coords[i])
    const rise = (route.elevations[i] ?? 0) - (route.elevations[i - 1] ?? 0)
    cumulativeAscentM[i] = cumulativeAscentM[i - 1] + Math.max(0, rise)
  }

  return {
    coords: route.coords,
    cumulativeM,
    cumulativeAscentM,
    elevations: route.elevations,
    totalM: cumulativeM[cumulativeM.length - 1],
  }
}

export interface RoutePosition {
  /** The segment the rider is on, identified by its first vertex. */
  index: number
  /** Metres from the start of the route to the snapped point. */
  alongM: number
  /** How far the fix is from the line, in metres. The off-route signal. */
  offsetM: number
  /** The snapped point itself, `[lon, lat]`, for drawing. */
  point: [number, number]
  /** Interpolated height at the snapped point, metres. */
  elevM: number
  /** The direction the route is heading here, degrees clockwise from true north. */
  bearing: number
}

/**
 * How far either side of the previous position to look before giving up and scanning it all.
 *
 * A cyclist covers at most ~25 m between 1 Hz fixes, but fixes drop out in cuttings and under
 * trees, so the forward window is generous. Backwards is much tighter: you can stop and roll
 * back a few metres, but a match 500 m behind is a mis-snap, not a rider reversing.
 */
const WINDOW_AHEAD_M = 600
const WINDOW_BEHIND_M = 120

/**
 * How bad a windowed match has to be before the whole route is searched.
 *
 * Above this the windowed answer is not credible as "the rider moved a bit", so it is worth
 * paying for a global scan — which is what recovers the position after a tunnel, a long
 * signal loss, or a route that was loaded with the rider already halfway along it.
 */
const WINDOW_TRUST_M = 45

/**
 * The point on the route nearest a fix.
 *
 * `hintAlongM` is the previous answer. It exists for two reasons and the second is the
 * important one: it makes the common case O(window) instead of O(route), *and* it disambiguates
 * a route that crosses itself. An out-and-back on the same road is two coincident lines, and a
 * global nearest-point search picks between them by floating-point luck — so a rider on the way
 * home would see the distance-remaining jump back to the full route length. The hint says which
 * pass you are on; the global fallback is only reached when the hint has clearly gone stale.
 */
export function snapToRoute(
  geometry: RouteGeometry,
  point: [number, number],
  hintAlongM: number | null = null,
): RoutePosition {
  const windowed =
    hintAlongM === null
      ? null
      : scan(
          geometry,
          point,
          hintAlongM - WINDOW_BEHIND_M,
          hintAlongM + WINDOW_AHEAD_M,
        )

  if (windowed && windowed.offsetM <= WINDOW_TRUST_M) return windowed

  // The hint is no longer credible. Scan everything, and take the windowed answer only if it
  // is still the better of the two — a tie goes to continuity, because a progress bar that
  // jumps is worse than one that lags.
  const global = scan(geometry, point, -Infinity, Infinity)!
  return windowed && windowed.offsetM <= global.offsetM ? windowed : global
}

/** Nearest point over the segments overlapping `[fromM, toM]`, or null if that is empty. */
function scan(
  geometry: RouteGeometry,
  point: [number, number],
  fromM: number,
  toM: number,
): RoutePosition | null {
  const { coords, cumulativeM } = geometry
  const cosLat = Math.cos(point[1] * DEG)
  const scaleX = EARTH_R * DEG * cosLat
  const scaleY = EARTH_R * DEG

  let bestIndex = -1
  let bestT = 0
  let bestSquared = Infinity

  for (let i = 0; i < coords.length - 1; i++) {
    // Skip whole segments outside the window, but keep any that straddle an edge.
    if (cumulativeM[i + 1] < fromM) continue
    if (cumulativeM[i] > toM) break

    const ax = (coords[i][0] - point[0]) * scaleX
    const ay = (coords[i][1] - point[1]) * scaleY
    const bx = (coords[i + 1][0] - point[0]) * scaleX
    const by = (coords[i + 1][1] - point[1]) * scaleY
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy

    // A zero-length segment — BRouter emits repeated points at some junctions — projects to
    // its own endpoint rather than dividing by zero.
    const t = lengthSquared === 0 ? 0 : clamp(-(ax * dx + ay * dy) / lengthSquared, 0, 1)
    const px = ax + t * dx
    const py = ay + t * dy
    const squared = px * px + py * py

    if (squared < bestSquared) {
      bestSquared = squared
      bestIndex = i
      bestT = t
    }
  }

  if (bestIndex === -1) return null

  const a = coords[bestIndex]
  const b = coords[bestIndex + 1]
  const segmentM = cumulativeM[bestIndex + 1] - cumulativeM[bestIndex]

  return {
    index: bestIndex,
    alongM: cumulativeM[bestIndex] + segmentM * bestT,
    offsetM: Math.sqrt(bestSquared),
    point: [a[0] + (b[0] - a[0]) * bestT, a[1] + (b[1] - a[1]) * bestT],
    elevM:
      (geometry.elevations[bestIndex] ?? 0) +
      ((geometry.elevations[bestIndex + 1] ?? 0) - (geometry.elevations[bestIndex] ?? 0)) * bestT,
    bearing: bearingBetween(a, b),
  }
}

/** Degrees clockwise from true north, matching what the Geolocation API reports. */
export function bearingBetween(a: [number, number], b: [number, number]): number {
  const φ1 = a[1] * DEG
  const φ2 = b[1] * DEG
  const Δλ = (b[0] - a[0]) * DEG
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) / DEG + 360) % 360
}

/**
 * The direction of travel over the next `lookaheadM` of route, rather than of one segment.
 *
 * A single BRouter segment can be two metres long, and its bearing swings wildly at a
 * junction — using it to orient the map produces a screen that lurches every time the road
 * kinks. Averaging over a short distance ahead gives the direction the rider is actually
 * about to go.
 */
export function routeBearingAhead(
  geometry: RouteGeometry,
  alongM: number,
  lookaheadM = 40,
): number {
  const here = pointAt(geometry, alongM)
  const there = pointAt(geometry, Math.min(alongM + lookaheadM, geometry.totalM))
  if (here[0] === there[0] && here[1] === there[1]) {
    // At the very end of the route, look backwards instead of returning an arbitrary zero.
    const before = pointAt(geometry, Math.max(0, alongM - lookaheadM))
    return bearingBetween(before, here)
  }
  return bearingBetween(here, there)
}

/** The `[lon, lat]` a given distance along the route, interpolated within its segment. */
export function pointAt(geometry: RouteGeometry, alongM: number): [number, number] {
  const { coords, cumulativeM } = geometry
  const target = clamp(alongM, 0, geometry.totalM)
  const i = segmentIndexAt(cumulativeM, target)
  const segmentM = cumulativeM[i + 1] - cumulativeM[i]
  const t = segmentM === 0 ? 0 : (target - cumulativeM[i]) / segmentM
  return [
    coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
  ]
}

/** Interpolated height a given distance along the route, metres. */
export function elevationAt(geometry: RouteGeometry, alongM: number): number {
  const { cumulativeM, elevations } = geometry
  const target = clamp(alongM, 0, geometry.totalM)
  const i = segmentIndexAt(cumulativeM, target)
  const segmentM = cumulativeM[i + 1] - cumulativeM[i]
  const t = segmentM === 0 ? 0 : (target - cumulativeM[i]) / segmentM
  return (elevations[i] ?? 0) + ((elevations[i + 1] ?? 0) - (elevations[i] ?? 0)) * t
}

/** Metres climbed by a given point along the route, interpolated. */
export function ascentBy(geometry: RouteGeometry, alongM: number): number {
  const { cumulativeM, cumulativeAscentM } = geometry
  const target = clamp(alongM, 0, geometry.totalM)
  const i = segmentIndexAt(cumulativeM, target)
  const segmentM = cumulativeM[i + 1] - cumulativeM[i]
  const t = segmentM === 0 ? 0 : (target - cumulativeM[i]) / segmentM
  return cumulativeAscentM[i] + (cumulativeAscentM[i + 1] - cumulativeAscentM[i]) * t
}

/** Binary search for the segment containing a distance. Returns a *segment* index. */
function segmentIndexAt(cumulativeM: number[], target: number): number {
  let low = 0
  let high = cumulativeM.length - 1
  while (low < high - 1) {
    const mid = (low + high) >> 1
    if (cumulativeM[mid] <= target) low = mid
    else high = mid
  }
  return Math.min(low, cumulativeM.length - 2)
}

/**
 * The distance over which the gradient under the wheels is measured.
 *
 * ±60 m, so 120 m in total. Shorter and the number is dominated by SRTM's vertical noise —
 * the elevation data is sampled on a ~30 m grid with metre-scale error, so a 20 m window can
 * show 15% on a flat road. Longer and a genuine short ramp is averaged into nothing, which is
 * the number a cyclist most wants.
 */
const GRADE_WINDOW_M = 60

/** Gradient at a point as a ratio — 0.05 is 5% — smoothed over {@link GRADE_WINDOW_M}. */
export function gradeAt(geometry: RouteGeometry, alongM: number): number {
  const from = Math.max(0, alongM - GRADE_WINDOW_M)
  const to = Math.min(geometry.totalM, alongM + GRADE_WINDOW_M)
  const run = to - from
  if (run < 1) return 0
  return (elevationAt(geometry, to) - elevationAt(geometry, from)) / run
}

export interface RideProgress {
  position: RoutePosition
  /** 0 at the start, 1 at the finish. What the progress bar reads. */
  fraction: number
  remainingM: number
  /** Climbing still to come, metres. The figure that decides whether to stop for food. */
  remainingAscentM: number
  /** Gradient under the wheels now, as a ratio. Positive uphill. */
  grade: number
}

export function rideProgress(geometry: RouteGeometry, position: RoutePosition): RideProgress {
  const remainingM = Math.max(0, geometry.totalM - position.alongM)
  return {
    position,
    fraction: geometry.totalM === 0 ? 1 : clamp(position.alongM / geometry.totalM, 0, 1),
    remainingM,
    remainingAscentM: Math.max(
      0,
      geometry.cumulativeAscentM[geometry.cumulativeAscentM.length - 1] -
        ascentBy(geometry, position.alongM),
    ),
    grade: gradeAt(geometry, position.alongM),
  }
}

/**
 * Seconds to the finish.
 *
 * Two estimates, blended. The **planned** pace is what the profile predicted for the whole
 * route, and it already accounts for the hills, junctions and surfaces still ahead. The
 * **observed** pace is the rider's recent average, which knows about the headwind, the loaded
 * panniers and the fact that they are tired. Neither alone is good: planned pace never adapts,
 * and observed pace extrapolates the last kilometre of descent across a route that finishes
 * uphill.
 *
 * Weighting the observed pace by how much of the route has been ridden is what makes it
 * settle: at the start it says almost nothing and the profile's estimate stands; by halfway
 * the rider's own pace dominates. `null` when neither estimate exists — which is exactly the
 * `shortest` profile, whose GPX carries no `time=` at all.
 */
export function etaSeconds(input: {
  remainingM: number
  /** Route length and predicted time, from the GPX summary. `null` time means no model. */
  plannedM: number
  plannedTimeS: number | null
  /** Metres actually ridden and seconds actually spent moving, this ride. */
  riddenM: number
  movingS: number
  fraction: number
}): number | null {
  const { remainingM, plannedM, plannedTimeS, riddenM, movingS, fraction } = input
  const plannedPace = plannedTimeS !== null && plannedM > 0 ? plannedTimeS / plannedM : null
  // Under a kilometre or a couple of minutes there is not enough signal to average, and a
  // pace taken from a standing start at the traffic lights predicts arrival next Tuesday.
  const observedPace = riddenM > 1000 && movingS > 120 ? movingS / riddenM : null

  if (plannedPace === null && observedPace === null) return null
  if (observedPace === null) return remainingM * plannedPace!
  if (plannedPace === null) return remainingM * observedPace

  const trust = clamp(fraction, 0, 1)
  return remainingM * (observedPace * trust + plannedPace * (1 - trust))
}

/**
 * Whether the rider has left the route, tracked across fixes rather than decided per fix.
 *
 * A single fix is not evidence. Urban GPS routinely throws a 60 m outlier between two good
 * fixes, and rerouting on one of those is how a navigation app earns a reputation for
 * sending you the wrong way down a street you were already riding correctly. So: several
 * consecutive fixes past a threshold that itself scales with the reported accuracy, because
 * a ±50 m fix simply cannot tell you which of two parallel streets you are on.
 *
 * Recovery is deliberately asymmetric — one good fix clears it. Being wrong about "back on
 * route" costs nothing; being wrong about "off route" costs a reroute.
 */
export interface OffRouteState {
  /** Consecutive fixes seen off the line. */
  strikes: number
  /** Whether we have concluded the rider is off route. */
  off: boolean
  /** When that conclusion was first reached, so a reroute can be rate-limited. */
  since: number | null
}

export const ON_ROUTE: OffRouteState = { strikes: 0, off: false, since: null }

/** Below this, a rider on the correct road can still snap wide — a dual carriageway is 30 m. */
const OFF_ROUTE_FLOOR_M = 40
/** How many consecutive bad fixes before believing them. At 1 Hz that is a few seconds. */
const OFF_ROUTE_STRIKES = 4

export function trackOffRoute(
  state: OffRouteState,
  sample: { offsetM: number; accuracyM: number; at: number },
): OffRouteState {
  // A fix that cannot tell the difference is not allowed to claim there is one.
  const threshold = Math.max(OFF_ROUTE_FLOOR_M, sample.accuracyM * 2)
  if (sample.offsetM <= threshold) return state.off || state.strikes > 0 ? ON_ROUTE : state

  const strikes = state.strikes + 1
  if (strikes < OFF_ROUTE_STRIKES) return { strikes, off: false, since: null }
  return { strikes, off: true, since: state.since ?? sample.at }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}
