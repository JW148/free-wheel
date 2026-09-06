import { haversineM } from './geo'
import type { ParsedRoute } from './gpx'

/**
 * The elevation profile, as distance-along-route against height.
 *
 * BRouter already hands back a `<ele>` for every track point, so this is data the app has
 * been throwing away rather than data it has to compute. What is missing is the x-axis:
 * GPX carries no cumulative distance, so it is summed from the coordinates.
 *
 * Kept separate from `gpx.ts` because that module's job is *parsing* — this is derivation,
 * it is only needed when something is actually drawn, and a 76 km route is thousands of
 * points that no one wants computed on every parse.
 */

export interface ElevationPoint {
  /** Metres from the start, along the route. */
  distanceM: number
  elevM: number
}

export interface ElevationProfileData {
  points: ElevationPoint[]
  minElevM: number
  maxElevM: number
  totalDistanceM: number
}

/**
 * Points to draw at most.
 *
 * A 76 km route is ~5,000 track points; an SVG path with 5,000 commands is both slow to
 * render and pointless at ~350 device pixels wide. Downsampling to roughly two points per
 * pixel keeps the shape while keeping the DOM small.
 */
const MAX_POINTS = 400

export function elevationProfile(route: ParsedRoute): ElevationProfileData | null {
  // One point is a position, not a profile — there is nothing to plot between.
  if (route.coords.length < 2) return null

  const cumulative: number[] = [0]
  for (let i = 1; i < route.coords.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineM(route.coords[i - 1], route.coords[i]))
  }
  const totalDistanceM = cumulative[cumulative.length - 1]

  // Stride rather than average: an averaged profile flattens exactly the short sharp climbs
  // a cyclist most wants to see coming.
  const stride = Math.max(1, Math.ceil(route.coords.length / MAX_POINTS))
  const points: ElevationPoint[] = []
  for (let i = 0; i < route.coords.length; i += stride) {
    points.push({ distanceM: cumulative[i], elevM: route.elevations[i] ?? 0 })
  }
  // Always keep the true last point, or the profile stops short of the finish.
  const lastIndex = route.coords.length - 1
  if (points[points.length - 1]?.distanceM !== cumulative[lastIndex]) {
    points.push({ distanceM: cumulative[lastIndex], elevM: route.elevations[lastIndex] ?? 0 })
  }

  // Extremes come from *every* point, not the downsampled ones: the summit is frequently
  // the point that sampling dropped, and reporting a peak lower than the route's actual
  // high point would be wrong in the direction that matters.
  let minElevM = Infinity
  let maxElevM = -Infinity
  for (const elev of route.elevations) {
    if (elev < minElevM) minElevM = elev
    if (elev > maxElevM) maxElevM = elev
  }

  return { points, minElevM, maxElevM, totalDistanceM }
}
