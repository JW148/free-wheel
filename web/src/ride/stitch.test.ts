import { describe, expect, it } from 'vitest'
import { parseBrouterGpx, type ParsedRoute } from './gpx'
import { routeGeometry, snapToRoute } from './progress'
import { riddenPrefix, stitchRoute, stitchedGpx } from './stitch'

/**
 * A route east along a line of latitude, one point every ~78 m, climbing steadily.
 *
 * Made up rather than a fixture, because the thing under test is arithmetic over a geometry
 * and a made-up one lets the expected answers be stated rather than measured.
 */
function straight(from: number, points: number, climbPerPoint = 2): ParsedRoute {
  const coords: [number, number][] = []
  const elevations: number[] = []
  for (let i = 0; i < points; i++) {
    coords.push([from + i * 0.001, 55.95])
    elevations.push(100 + i * climbPerPoint)
  }
  return {
    coords,
    elevations,
    distanceM: 0,
    ascendM: (points - 1) * climbPerPoint,
    timeS: 600,
    name: 'test',
  }
}

const measured = (route: ParsedRoute): ParsedRoute => ({
  ...route,
  distanceM: routeGeometry(route)!.totalM,
})

describe('riddenPrefix', () => {
  const route = measured(straight(-3.2, 21))
  const geometry = routeGeometry(route)!

  it('cuts exactly where the rider left the route, not at the nearest vertex', () => {
    const prefix = riddenPrefix(geometry, route, 500)
    expect(prefix.distanceM).toBe(500)
    // Re-measuring the kept coordinates has to agree with the distance claimed for them, or the
    // stitched route's total is a number that describes nothing.
    const back = routeGeometry({ ...route, coords: prefix.coords, elevations: prefix.elevations })!
    expect(back.totalM).toBeCloseTo(500, 0)
  })

  it('keeps the climbing already done and pro-rates the estimate', () => {
    const half = geometry.totalM / 2
    const prefix = riddenPrefix(geometry, route, half)
    expect(prefix.ascentM).toBeGreaterThan(15)
    expect(prefix.ascentM).toBeLessThan(25)
    expect(prefix.timeS).toBeCloseTo(300, 0)
  })

  it('says nothing about time for a profile that gave no estimate', () => {
    const prefix = riddenPrefix(geometry, { ...route, timeS: null }, 500)
    expect(prefix.timeS).toBeNull()
  })

  it('is the whole route when the rider is at the finish, and nothing at the start', () => {
    expect(riddenPrefix(geometry, route, geometry.totalM).distanceM).toBeCloseTo(geometry.totalM, 6)
    expect(riddenPrefix(geometry, route, 0).coords).toHaveLength(1)
  })

  it('clamps a position past either end rather than running off the array', () => {
    expect(riddenPrefix(geometry, route, -400).distanceM).toBe(0)
    expect(riddenPrefix(geometry, route, 1e6).distanceM).toBeCloseTo(geometry.totalM, 6)
  })
})

describe('stitchRoute', () => {
  const original = measured(straight(-3.2, 21))
  const geometry = routeGeometry(original)!
  // The rider is 1 km along, and 200 m north of the line — which is why there is a reroute.
  const alongM = 1000
  const prefix = riddenPrefix(geometry, original, alongM)
  const fresh = measured(straight(-3.2 + 1000 / 62_000, 11))

  it('keeps the original start', () => {
    const joined = stitchRoute(prefix, fresh)
    expect(joined.coords[0]).toEqual(original.coords[0])
  })

  it('adds the road ahead to the road already ridden rather than replacing it', () => {
    const joined = stitchRoute(prefix, fresh)
    // The whole point: the trip does not shrink to the leg that was just computed.
    expect(joined.distanceM).toBeGreaterThan(fresh.distanceM)
    expect(joined.distanceM).toBeGreaterThanOrEqual(alongM + fresh.distanceM)
    expect(joined.ascendM).toBeCloseTo(prefix.ascentM + fresh.ascendM, 6)
    expect(joined.timeS).toBeCloseTo(prefix.timeS! + fresh.timeS!, 6)
  })

  it('leaves the rider where they actually are along the joined route', () => {
    const joined = stitchRoute(prefix, fresh)
    const stitchedGeometry = routeGeometry(joined)!
    const here = snapToRoute(stitchedGeometry, fresh.coords[0], joined.resumeAtM)
    expect(here.alongM).toBeCloseTo(joined.resumeAtM!, 0)
    // And therefore has not been sent back to the start of the ride.
    expect(here.alongM).toBeGreaterThan(900)
  })

  it('reports no estimate when either half has none', () => {
    expect(stitchRoute({ ...prefix, timeS: null }, fresh).timeS).toBeNull()
    expect(stitchRoute(prefix, { ...fresh, timeS: null }).timeS).toBeNull()
  })

  it('counts the gap the rider covered getting off the route', () => {
    const away = measured(straight(-3.2 + 1000 / 62_000, 11))
    away.coords = away.coords.map(([lon, lat]) => [lon, lat + 0.002] as [number, number])
    const joined = stitchRoute(prefix, away)
    expect(joined.distanceM).toBeGreaterThan(alongM + away.distanceM + 150)
  })
})

describe('stitchedGpx', () => {
  const original = measured(straight(-3.2, 21))
  const geometry = routeGeometry(original)!
  const joined = stitchRoute(
    riddenPrefix(geometry, original, 1000),
    measured(straight(-3.2 + 1000 / 62_000, 11)),
  )

  it('reads back through the engine parser it imitates', () => {
    const reparsed = parseBrouterGpx(stitchedGpx(joined, 'free-wheel_trekking'))
    expect(reparsed.coords).toHaveLength(joined.coords.length)
    expect(reparsed.coords[0][0]).toBeCloseTo(joined.coords[0][0], 6)
    expect(reparsed.distanceM).toBe(Math.round(joined.distanceM))
    expect(reparsed.ascendM).toBe(Math.round(joined.ascendM))
    expect(reparsed.timeS).toBeCloseTo(joined.timeS!, -1)
    expect(reparsed.name).toBe('free-wheel_trekking')
  })

  it('keeps the heights, so the ride still has an elevation profile after a reroute', () => {
    const reparsed = parseBrouterGpx(stitchedGpx(joined, 'x'))
    expect(reparsed.elevations.some((e) => e !== 0)).toBe(true)
  })

  it('writes no time at all for a profile with no energy model', () => {
    // `time=0s` would be rendered as "0 min", which is a claim rather than an absence.
    const doc = stitchedGpx({ ...joined, timeS: null }, 'x')
    expect(doc).not.toContain('time=')
    expect(parseBrouterGpx(doc).timeS).toBeNull()
  })
})
