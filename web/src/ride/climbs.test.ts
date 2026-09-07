import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx, type ParsedRoute } from './gpx'
import { haversineM } from './geo'
import { routeGeometry } from './progress'
import { gradients, nextGradient, severityOf } from './climbs'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

/** A route running due east, so distance along is exactly the metres asked for. */
function eastward(profile: { atM: number; elevM: number }[]): ParsedRoute {
  const lat = 55.95
  const perDegree = haversineM([0, lat], [1, lat])
  return {
    coords: profile.map((p) => [p.atM / perDegree, lat] as [number, number]),
    elevations: profile.map((p) => p.elevM),
    distanceM: profile[profile.length - 1].atM,
    ascendM: 0,
    timeS: null,
    name: 'synthetic',
  }
}

/** Points every 10 m, height from a function of distance. Dense enough to smooth honestly. */
function shaped(totalM: number, height: (m: number) => number): ParsedRoute {
  const points = []
  for (let m = 0; m <= totalM; m += 10) points.push({ atM: m, elevM: height(m) })
  return eastward(points)
}

describe('gradients', () => {
  it('finds one climb in a route that is flat, up, and flat again', () => {
    const route = shaped(3000, (m) => (m < 1000 ? 50 : m < 2000 ? 50 + (m - 1000) * 0.06 : 110))
    const found = gradients(routeGeometry(route)!)

    expect(found).toHaveLength(1)
    const [climb] = found
    expect(climb.kind).toBe('climb')
    expect(climb.gainM).toBeCloseTo(60, -1)
    // Smoothing rounds the shoulders, which widens the bracket by about half the window at
    // each end and so reads the gradient slightly shallow — 5.3% for a true 6%. That is the
    // price of not reporting a towpath as two hundred climbs, and it is under 15%.
    expect(climb.grade).toBeGreaterThan(0.051)
    expect(climb.grade).toBeLessThan(0.061)
    // Smoothing rounds the shoulders, so the boundaries land near the true ones rather than on
    // them. Within 100 m either side is what a rider could act on.
    expect(climb.startM).toBeGreaterThan(900)
    expect(climb.startM).toBeLessThan(1100)
    expect(climb.endM).toBeGreaterThan(1900)
    expect(climb.endM).toBeLessThan(2100)
  })

  it('finds the descent on the other side', () => {
    const route = shaped(4000, (m) =>
      m < 1000 ? 50 : m < 2000 ? 50 + (m - 1000) * 0.06 : m < 3000 ? 110 - (m - 2000) * 0.06 : 50,
    )
    const found = gradients(routeGeometry(route)!)
    expect(found.map((g) => g.kind)).toEqual(['climb', 'descent'])
    expect(found[1].gainM).toBeCloseTo(60, -1)
  })

  it('keeps a climb with a false flat in the middle as one climb', () => {
    // 40 m up, 3 m of dip, 40 m more up. Three features would be a lie about the road.
    const route = shaped(3000, (m) => {
      if (m < 500) return 100
      if (m < 1200) return 100 + (m - 500) * 0.0571
      if (m < 1400) return 140 - (m - 1200) * 0.015
      if (m < 2200) return 137 + (m - 1400) * 0.05
      return 177
    })
    const found = gradients(routeGeometry(route)!)
    expect(found).toHaveLength(1)
    expect(found[0].gainM).toBeGreaterThan(70)
  })

  it('has nothing to say about a flat towpath, noise and all', () => {
    // ±1.5 m of SRTM noise on a dead flat route. Without smoothing this is 200 "climbs".
    const route = shaped(5000, (m) => 20 + Math.sin(m / 37) * 1.5 + Math.sin(m / 91) * 1.2)
    expect(gradients(routeGeometry(route)!)).toEqual([])
  })

  it('ignores a bump too small or too short to be worth mentioning', () => {
    const route = shaped(2000, (m) => (m > 900 && m < 1000 ? 60 : 50))
    expect(gradients(routeGeometry(route)!)).toEqual([])
  })

  it('pulls a wall out of the drag leading up to it rather than averaging the two', () => {
    // 1 km at 2%, then 300 m at 12%. Reported as one 4.3% climb, a rider arrives at the wall
    // in the wrong gear. The score has to prefer the split here — and only here.
    const route = shaped(2500, (m) =>
      m < 500 ? 0 : m < 1500 ? (m - 500) * 0.02 : m < 1800 ? 20 + (m - 1500) * 0.12 : 56,
    )
    const found = gradients(routeGeometry(route)!)

    expect(found).toHaveLength(2)
    expect(found[0].grade).toBeLessThan(0.035)
    expect(found[1].grade).toBeGreaterThan(0.08)
    expect(found[1].startM).toBeGreaterThan(found[0].endM - 1e-6)
  })

  it('keeps a climb whole when it merely steepens, and says so with maxGrade', () => {
    // 1 km at 5% then 300 m at 7%. Not a different climb — the same climb, getting harder.
    const route = shaped(2500, (m) =>
      m < 500 ? 0 : m < 1500 ? (m - 500) * 0.05 : m < 1800 ? 50 + (m - 1500) * 0.07 : 71,
    )
    const found = gradients(routeGeometry(route)!)

    expect(found).toHaveLength(1)
    expect(found[0].grade).toBeGreaterThan(0.045)
    expect(found[0].grade).toBeLessThan(0.06)
    expect(found[0].maxGrade).toBeGreaterThan(found[0].grade)
  })

  it('leaves a route with nowhere to go alone', () => {
    expect(gradients(routeGeometry(shaped(100, () => 10))!)).toEqual([])
  })

  it('finds a plausible number of features on a real 90 km route', () => {
    const geometry = routeGeometry(parseBrouterGpx(fixture('london-brighton.gpx')))!
    const found = gradients(geometry)

    // The point of the test is that it is neither zero nor hundreds: both are the failure
    // modes of an unsmoothed threshold, and both make the feature useless.
    expect(found.length).toBeGreaterThan(3)
    expect(found.length).toBeLessThan(60)

    for (const gradient of found) {
      expect(gradient.startM).toBeGreaterThanOrEqual(0)
      expect(gradient.endM).toBeLessThanOrEqual(geometry.totalM + 1)
      expect(gradient.endM).toBeGreaterThan(gradient.startM)
      expect(gradient.maxGrade).toBeGreaterThanOrEqual(gradient.grade - 1e-9)
    }

    // Runs are contiguous, so features never overlap.
    for (let i = 1; i < found.length; i++) {
      expect(found[i].startM).toBeGreaterThanOrEqual(found[i - 1].endM - 1e-6)
    }
  })
})

describe('severityOf', () => {
  it('ranks a short ramp below a long drag below a wall', () => {
    expect(severityOf(15, 0.04)).toBe('easy')
    expect(severityOf(80, 0.05)).toBe('moderate')
    expect(severityOf(120, 0.08)).toBe('hard')
    expect(severityOf(400, 0.08)).toBe('brutal')
  })

  it('does not let a long shallow drag outrank a genuine wall', () => {
    // 200 m of climbing at 2% is a valley road; 60 m at 12% is a wall.
    expect(severityOf(200, 0.02)).toBe('moderate')
    expect(severityOf(60, 0.12)).toBe('hard')
  })
})

describe('nextGradient', () => {
  const route = shaped(6000, (m) =>
    m < 1000 ? 50 : m < 2000 ? 50 + (m - 1000) * 0.06 : m < 3000 ? 110 - (m - 2000) * 0.06 : 50,
  )
  const found = gradients(routeGeometry(route)!)

  it('points at the climb ahead and says how far off it is', () => {
    const ahead = nextGradient(found, 0)!
    expect(ahead.gradient.kind).toBe('climb')
    expect(ahead.inIt).toBe(false)
    expect(ahead.distanceToM).toBeGreaterThan(850)
  })

  it('switches to what is left once the rider is on it', () => {
    const ahead = nextGradient(found, 1500)!
    expect(ahead.inIt).toBe(true)
    expect(ahead.distanceToM).toBe(0)
    expect(ahead.remainingM).toBeGreaterThan(300)
    expect(ahead.remainingGainM).toBeGreaterThan(15)
    expect(ahead.remainingGainM).toBeLessThan(ahead.gradient.gainM)
  })

  it('can be asked for the next rest rather than the next effort', () => {
    const rest = nextGradient(found, 0, 'descent')!
    expect(rest.gradient.kind).toBe('descent')
    expect(rest.distanceToM).toBeGreaterThan(1800)
  })

  it('says nothing once everything is behind you', () => {
    expect(nextGradient(found, 5500)).toBeNull()
  })
})
