import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx } from './gpx'
import { elevationComparison, elevationProfile } from './elevation'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

describe('elevationProfile', () => {
  const short = elevationProfile(parseBrouterGpx(fixture('urban-short.gpx')))!
  const long = elevationProfile(parseBrouterGpx(fixture('london-brighton.gpx')))!

  it('measures distance along the route, close to what BRouter reported', () => {
    // Summed from coordinates rather than taken from the header, so it is worth checking the
    // two agree. They will not agree exactly — BRouter accumulates per segment in fixed point
    // — but a few percent apart means the summing is right.
    const reported = parseBrouterGpx(fixture('urban-short.gpx')).distanceM
    expect(short.totalDistanceM).toBeGreaterThan(reported * 0.95)
    expect(short.totalDistanceM).toBeLessThan(reported * 1.05)
  })

  it('starts at zero and rises monotonically', () => {
    expect(short.points[0].distanceM).toBe(0)
    for (let i = 1; i < short.points.length; i++) {
      expect(short.points[i].distanceM).toBeGreaterThanOrEqual(short.points[i - 1].distanceM)
    }
  })

  it('downsamples a long route but keeps the finish', () => {
    // A 76 km route is thousands of points; an SVG path that long is slow and invisible at
    // ~350px wide.
    expect(long.points.length).toBeLessThanOrEqual(401)
    expect(long.points.length).toBeGreaterThan(100)
    expect(long.points.at(-1)!.distanceM).toBeCloseTo(long.totalDistanceM, 6)
  })

  it('takes extremes from every point, not just the sampled ones', () => {
    // The summit is very often a point that downsampling dropped. Reporting a peak lower
    // than the route actually reaches would be wrong in the direction that matters.
    const all = parseBrouterGpx(fixture('london-brighton.gpx')).elevations
    expect(long.maxElevM).toBe(Math.max(...all))
    expect(long.minElevM).toBe(Math.min(...all))
    expect(long.maxElevM).toBeGreaterThanOrEqual(Math.max(...long.points.map((p) => p.elevM)))
  })

  it('returns null when there is nothing to plot', () => {
    const single = parseBrouterGpx(
      '<gpx><trk><trkseg><trkpt lon="-3.19" lat="55.95"><ele>7</ele></trkpt></trkseg></trk></gpx>',
    )
    expect(elevationProfile(single)).toBeNull()
  })
})

describe('elevationComparison', () => {
  const short = parseBrouterGpx(fixture('urban-short.gpx'))
  const long = parseBrouterGpx(fixture('london-brighton.gpx'))

  it('returns null when there is nothing to compare', () => {
    // One route is what the detail view already draws, and it draws it better — auto-scaled
    // to itself rather than to a comparison of one.
    expect(elevationComparison({})).toBeNull()
    expect(elevationComparison({ trekking: short })).toBeNull()
  })

  it('shares one distance axis across every route', () => {
    const comparison = elevationComparison({ trekking: short, gravel: long })!
    const longest = elevationProfile(long)!.totalDistanceM
    expect(comparison.maxDistanceM).toBeCloseTo(longest, 6)
    // The shorter route must stop short of the axis rather than be stretched to fill it —
    // that is the whole point of plotting them together.
    expect(comparison.series.find((s) => s.id === 'trekking')!.points.at(-1)!.distanceM)
      .toBeLessThan(comparison.maxDistanceM)
  })

  it('shares one height axis, spanning every route', () => {
    const each = [elevationProfile(short)!, elevationProfile(long)!]
    const comparison = elevationComparison({ trekking: short, gravel: long })!
    expect(comparison.minElevM).toBe(Math.min(...each.map((p) => p.minElevM)))
    expect(comparison.maxElevM).toBe(Math.max(...each.map((p) => p.maxElevM)))
  })

  it('drops a route with no plottable profile rather than skewing the axes', () => {
    const degenerate = { ...short, coords: [short.coords[0]], elevations: [short.elevations[0]] }
    const comparison = elevationComparison({ trekking: short, gravel: long, mtb: degenerate })!
    expect(comparison.series.map((s) => s.id)).toEqual(['trekking', 'gravel'])
  })
})
