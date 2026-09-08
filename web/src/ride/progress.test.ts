import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx, type ParsedRoute } from './gpx'
import { haversineM } from './geo'
import {
  ascentBy,
  bearingBetween,
  elevationAt,
  etaSeconds,
  gradeAt,
  ON_ROUTE,
  pointAt,
  rideProgress,
  routeBearingAhead,
  routeGeometry,
  sliceAlong,
  snapToRoute,
  trackOffRoute,
  waypointsAhead,
} from './progress'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

const short = routeGeometry(parseBrouterGpx(fixture('urban-short.gpx')))!
const long = routeGeometry(parseBrouterGpx(fixture('london-brighton.gpx')))!

/** A synthetic route, so the expected answers can be arithmetic rather than approximate. */
function straightEastRoute(metres: number[], elevations: number[]): ParsedRoute {
  const lat = 55.95
  const perDegree = haversineM([0, lat], [1, lat])
  return {
    coords: metres.map((m) => [m / perDegree, lat] as [number, number]),
    elevations,
    distanceM: metres[metres.length - 1],
    ascendM: 0,
    timeS: null,
    name: 'straight',
  }
}

describe('routeGeometry', () => {
  it('sums to something very close to what BRouter reported', () => {
    const reported = parseBrouterGpx(fixture('urban-short.gpx')).distanceM
    expect(short.totalM).toBeGreaterThan(reported * 0.97)
    expect(short.totalM).toBeLessThan(reported * 1.03)
  })

  it('counts only the climbing, so cumulative ascent never falls', () => {
    for (let i = 1; i < long.cumulativeAscentM.length; i++) {
      expect(long.cumulativeAscentM[i]).toBeGreaterThanOrEqual(long.cumulativeAscentM[i - 1])
    }
    // Unfiltered ascent over a real route is larger than BRouter's filtered figure — that is
    // the point of the filter — but it must be the same order of magnitude, not ten times it.
    const filtered = parseBrouterGpx(fixture('london-brighton.gpx')).ascendM
    const total = long.cumulativeAscentM[long.cumulativeAscentM.length - 1]
    expect(total).toBeGreaterThan(filtered * 0.5)
    expect(total).toBeLessThan(filtered * 3)
  })

  it('has nothing to say about a route with one point', () => {
    expect(routeGeometry({ ...straightEastRoute([0], [0]), coords: [[0, 0]] })).toBeNull()
  })
})

describe('snapToRoute', () => {
  const line = routeGeometry(straightEastRoute([0, 100, 200, 300], [0, 0, 0, 0]))!

  it('puts a point beside the line at the right distance along, and reports the offset', () => {
    const at150 = pointAt(line, 150)
    // Nudge north. One degree of latitude is ~111 km, so this is ~22 m off the line.
    const snapped = snapToRoute(line, [at150[0], at150[1] + 0.0002])
    expect(snapped.alongM).toBeCloseTo(150, 0)
    expect(snapped.offsetM).toBeGreaterThan(20)
    expect(snapped.offsetM).toBeLessThan(24)
  })

  it('clamps to the ends rather than extrapolating past them', () => {
    const start = pointAt(line, 0)
    const before = snapToRoute(line, [start[0] - 0.01, start[1]])
    expect(before.alongM).toBe(0)
    const finish = pointAt(line, 300)
    const after = snapToRoute(line, [finish[0] + 0.01, finish[1]])
    expect(after.alongM).toBeCloseTo(300, 0)
  })

  it('lands on the real route, close to every point of it', () => {
    for (let i = 0; i < short.coords.length; i += 7) {
      const snapped = snapToRoute(short, short.coords[i], null)
      expect(snapped.offsetM).toBeLessThan(0.5)
      expect(snapped.alongM).toBeCloseTo(short.cumulativeM[i], 0)
    }
  })

  it('follows the hint through a route that doubles back on itself', () => {
    // Out and back along the same 300 m. Without a hint the two passes are indistinguishable,
    // and getting it wrong makes the distance remaining jump back to the full route length
    // exactly when the rider is nearly home. Offset from the line, as a real fix would be.
    const outAndBack = routeGeometry(
      straightEastRoute([0, 100, 200, 300, 200, 100, 0], [0, 0, 0, 0, 0, 0, 0]),
    )!
    const midpoint = pointAt(outAndBack, 150)
    const beside: [number, number] = [midpoint[0], midpoint[1] + 0.0002]

    expect(snapToRoute(outAndBack, beside, 150).alongM).toBeCloseTo(150, 0)
    // 450 along the 600 m out-and-back is the same ground, on the way home.
    expect(snapToRoute(outAndBack, beside, 450).alongM).toBeCloseTo(450, 0)
  })

  it('recovers from a stale hint by scanning the whole route', () => {
    // A hint from the very start with the rider three quarters of the way along: the window
    // cannot see them, so the global scan has to.
    const target = pointAt(long, long.totalM * 0.75)
    const snapped = snapToRoute(long, target, 0)
    expect(snapped.alongM).toBeCloseTo(long.totalM * 0.75, -1)
  })

  it('reports how far off the line a rider has strayed, which is the off-route signal', () => {
    // On the straight line rather than a real route: London to Brighton doubles back through
    // dense streets, and a point 220 m from the 1 km mark is genuinely 29 m from *some* part
    // of it. That is correct behaviour and useless as an assertion.
    const at150 = pointAt(line, 150)
    const snapped = snapToRoute(line, [at150[0], at150[1] + 0.002], 150)
    expect(snapped.offsetM).toBeGreaterThan(200)
    expect(snapped.offsetM).toBeLessThan(240)
  })
})

describe('sliceAlong', () => {
  const line = routeGeometry(straightEastRoute([0, 100, 200, 300], [0, 0, 0, 0]))!

  it('interpolates both ends rather than snapping to a vertex', () => {
    const slice = sliceAlong(line, 50, 250)
    expect(slice).toHaveLength(4)
    expect(slice[0]).toEqual(pointAt(line, 50))
    expect(slice[slice.length - 1]).toEqual(pointAt(line, 250))
  })

  it('keeps every vertex strictly inside the range', () => {
    expect(sliceAlong(line, 0, 300)).toHaveLength(4)
    expect(sliceAlong(line, 120, 180)).toHaveLength(2)
  })

  it('clamps to the route and copes with a reversed range', () => {
    expect(sliceAlong(line, -500, 9999)).toHaveLength(4)
    expect(sliceAlong(line, 250, 50)).toHaveLength(4)
  })

  it('returns nothing drawable for an empty range', () => {
    expect(sliceAlong(line, 100, 100)).toEqual([])
    expect(sliceAlong(line, 400, 500)).toEqual([])
  })

  it('follows the real route without shortcuts', () => {
    // The slice from 0 to the end must be the route, vertex for vertex.
    const whole = sliceAlong(short, 0, short.totalM)
    expect(whole).toHaveLength(short.coords.length)
  })
})

describe('elevationAt and gradeAt', () => {
  // 1 km flat, then 1 km climbing 100 m — a 10% wall — then 1 km flat.
  const hill = routeGeometry(
    straightEastRoute([0, 1000, 2000, 3000], [50, 50, 150, 150]),
  )!

  it('interpolates height within a segment', () => {
    expect(elevationAt(hill, 1500)).toBeCloseTo(100, 2)
    expect(elevationAt(hill, 0)).toBe(50)
    expect(elevationAt(hill, 3000)).toBe(150)
  })

  it('clamps outside the route rather than extrapolating a cliff', () => {
    expect(elevationAt(hill, -500)).toBe(50)
    expect(elevationAt(hill, 9999)).toBe(150)
  })

  it('reads the gradient in the middle of the climb', () => {
    expect(gradeAt(hill, 1500)).toBeCloseTo(0.1, 3)
  })

  it('reads flat as flat', () => {
    expect(gradeAt(hill, 500)).toBeCloseTo(0, 6)
    expect(gradeAt(hill, 2500)).toBeCloseTo(0, 6)
  })

  it('smooths across the foot of the climb rather than jumping', () => {
    // Half the ±60 m window is on the flat, so the number should be about half the grade.
    expect(gradeAt(hill, 1000)).toBeCloseTo(0.05, 2)
  })

  it('tracks climbing done as a running total', () => {
    expect(ascentBy(hill, 0)).toBe(0)
    expect(ascentBy(hill, 1000)).toBeCloseTo(0, 2)
    expect(ascentBy(hill, 1500)).toBeCloseTo(50, 2)
    expect(ascentBy(hill, 3000)).toBeCloseTo(100, 2)
  })
})

describe('bearings', () => {
  it('measures clockwise from north, like the Geolocation API', () => {
    expect(bearingBetween([0, 0], [0, 1])).toBeCloseTo(0, 3)
    expect(bearingBetween([0, 0], [1, 0])).toBeCloseTo(90, 3)
    expect(bearingBetween([0, 0], [0, -1])).toBeCloseTo(180, 3)
    expect(bearingBetween([0, 0], [-1, 0])).toBeCloseTo(270, 3)
  })

  it('looks ahead rather than at the segment underfoot', () => {
    // A 2 m kink to the north sits inside the lookahead, so it must not dominate the answer.
    const kinked = routeGeometry({
      ...straightEastRoute([0, 100, 200], [0, 0, 0]),
      coords: [
        [0, 55.95],
        [0.0000004, 55.9500179],
        [0.0016, 55.95],
      ],
    })!
    expect(routeBearingAhead(kinked, 0, 60)).toBeGreaterThan(60)
    expect(routeBearingAhead(kinked, 0, 60)).toBeLessThan(120)
  })

  it('looks backwards at the finish, where there is nothing ahead', () => {
    const line = routeGeometry(straightEastRoute([0, 100, 200], [0, 0, 0]))!
    expect(routeBearingAhead(line, 200, 40)).toBeCloseTo(90, 0)
  })
})

describe('rideProgress', () => {
  const hill = routeGeometry(straightEastRoute([0, 1000, 2000], [0, 100, 100]))!

  it('reports the fraction, what is left, and the climbing still to come', () => {
    const progress = rideProgress(hill, snapToRoute(hill, pointAt(hill, 500), null))
    expect(progress.fraction).toBeCloseTo(0.25, 2)
    expect(progress.remainingM).toBeCloseTo(1500, 0)
    expect(progress.remainingAscentM).toBeCloseTo(50, 0)
  })

  it('has nothing left to climb once the climbing is done', () => {
    const progress = rideProgress(hill, snapToRoute(hill, pointAt(hill, 1600), null))
    expect(progress.remainingAscentM).toBeCloseTo(0, 6)
  })
})

describe('etaSeconds', () => {
  const base = { remainingM: 10_000, plannedM: 20_000, plannedTimeS: 3600, riddenM: 0, movingS: 0, fraction: 0 }

  it('uses the profile’s own pace before there is anything observed', () => {
    expect(etaSeconds(base)).toBeCloseTo(1800, 0)
  })

  it('says nothing at all when the profile has no time model and nor has the rider', () => {
    expect(etaSeconds({ ...base, plannedTimeS: null })).toBeNull()
  })

  it('falls back to the rider’s pace when the profile has no model', () => {
    // 10 km in 1800 s is 5.56 m/s; 10 km left is another 1800 s.
    expect(
      etaSeconds({ ...base, plannedTimeS: null, riddenM: 10_000, movingS: 1800, fraction: 0.5 }),
    ).toBeCloseTo(1800, 0)
  })

  it('ignores a pace taken from a standing start at the lights', () => {
    // 40 m in 60 s would extrapolate to four hours. The floor throws it away.
    expect(etaSeconds({ ...base, riddenM: 40, movingS: 60, fraction: 0.002 })).toBeCloseTo(1800, 0)
  })

  it('leans further on the rider’s own pace the further into the ride they are', () => {
    // Riding at half the predicted pace. Early on the profile still dominates; by the end the
    // estimate should have caught up with reality.
    const slow = { ...base, riddenM: 10_000, movingS: 3600 }
    const early = etaSeconds({ ...slow, fraction: 0.1 })!
    const late = etaSeconds({ ...slow, fraction: 0.9 })!
    expect(early).toBeGreaterThan(1800)
    expect(late).toBeGreaterThan(early)
    expect(late).toBeLessThanOrEqual(3600)
  })
})

describe('waypointsAhead', () => {
  const line = routeGeometry(straightEastRoute([0, 1000, 2000, 3000], [0, 0, 0, 0]))!
  const at = (m: number) => {
    const [lon, lat] = pointAt(line, m)
    return { lon, lat }
  }
  const plan = [at(0), at(1000), at(2000), at(3000)]

  it('drops the start and the via points already ridden through', () => {
    expect(waypointsAhead(line, plan, 1500)).toEqual([plan[2], plan[3]])
  })

  it('drops the start even before the rider has moved, because it is behind them by definition', () => {
    expect(waypointsAhead(line, plan, 0)).toEqual([plan[1], plan[2], plan[3]])
  })

  it('reduces a plain start-to-finish plan to the finish', () => {
    expect(waypointsAhead(line, [plan[0], plan[3]], 500)).toEqual([plan[3]])
  })

  it('always keeps the finish, whatever the snapping says', () => {
    expect(waypointsAhead(line, plan, 3000)).toEqual([plan[3]])
    expect(waypointsAhead(line, plan, 9999)).toEqual([plan[3]])
  })

  it('does not treat standing a few metres past a via point as having gone through it', () => {
    // 15 m past. Within the margin, so the via point survives — a GPS fix cannot tell the
    // difference and sending the rider on without it would silently change the route.
    expect(waypointsAhead(line, plan, 1015)).toContain(plan[1])
  })

  it('has nothing to say about an empty plan', () => {
    expect(waypointsAhead(line, [], 0)).toEqual([])
  })
})

describe('trackOffRoute', () => {
  const fix = (offsetM: number, at = 0, accuracyM = 8) => ({ offsetM, accuracyM, at })

  it('says nothing about a rider on the line', () => {
    expect(trackOffRoute(ON_ROUTE, fix(5))).toBe(ON_ROUTE)
  })

  it('ignores a single wild fix between good ones', () => {
    let state = trackOffRoute(ON_ROUTE, fix(120, 1))
    expect(state.off).toBe(false)
    state = trackOffRoute(state, fix(6, 2))
    expect(state).toEqual(ON_ROUTE)
  })

  it('concludes the rider is off route only after several consecutive fixes', () => {
    let state = ON_ROUTE
    for (let i = 1; i <= 3; i++) state = trackOffRoute(state, fix(200, i))
    expect(state.off).toBe(false)
    state = trackOffRoute(state, fix(200, 4))
    expect(state.off).toBe(true)
    expect(state.since).toBe(4)
  })

  it('keeps the original timestamp so a reroute can be rate-limited', () => {
    let state = ON_ROUTE
    for (let i = 1; i <= 8; i++) state = trackOffRoute(state, fix(200, i))
    expect(state.since).toBe(4)
  })

  it('refuses to call a rider off route on a fix too vague to know', () => {
    // ±150 m in an urban canyon. 200 m from the line is within the noise.
    let state = ON_ROUTE
    for (let i = 1; i <= 8; i++) state = trackOffRoute(state, fix(200, i, 150))
    expect(state.off).toBe(false)
  })

  it('comes back on route on the first good fix', () => {
    let state = ON_ROUTE
    for (let i = 1; i <= 8; i++) state = trackOffRoute(state, fix(200, i))
    expect(trackOffRoute(state, fix(10, 9))).toEqual(ON_ROUTE)
  })
})
