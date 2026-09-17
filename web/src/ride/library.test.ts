import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx } from './gpx'
import {
  byNewest,
  defaultRouteName,
  filterEntries,
  previewOf,
  renamed,
  rideEntry,
  rideTotals,
  routeEntry,
  type SavedRide,
} from './library'
import { summarise, startRecording } from './recording'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

describe('previewOf', () => {
  it('leaves a short route alone', () => {
    const coords: [number, number][] = [
      [0, 0],
      [1, 1],
    ]
    expect(previewOf(coords)).toEqual(coords)
  })

  it('thins a long route but keeps both ends, so a loop still closes', () => {
    const coords = Array.from({ length: 5000 }, (_, i) => [i / 1000, 55] as [number, number])
    const preview = previewOf(coords)
    expect(preview.length).toBeLessThanOrEqual(48)
    expect(preview[0]).toEqual(coords[0])
    expect(preview[preview.length - 1]).toEqual(coords[coords.length - 1])
  })

  it('samples evenly across a real route rather than clustering', () => {
    const route = parseBrouterGpx(fixture('london-brighton.gpx'))
    const preview = previewOf(route.coords)
    // Longitude runs monotonically enough over London to Brighton for a crude spread check:
    // every consecutive pair must actually differ, which a clustered sample would not.
    const distinct = new Set(preview.map((p) => p.join(',')))
    expect(distinct.size).toBe(preview.length)
  })
})

describe('defaultRouteName', () => {
  it('names a route by when and how far, because there is no geocoder offline', () => {
    const name = defaultRouteName(Date.UTC(2026, 8, 8, 9, 0), 12_340)
    expect(name).toContain('12.3 km')
  })

  it('says metres for something under a kilometre', () => {
    expect(defaultRouteName(Date.now(), 640)).toContain('640 m')
  })
})

describe('routeEntry', () => {
  const route = parseBrouterGpx(fixture('urban-short.gpx'))
  const waypoints = [
    { id: 'a', lon: -0.1278, lat: 51.5074 },
    { id: 'b', lon: -0.12, lat: 51.51 },
  ]

  it('denormalises the figures the list draws, so no GPX is parsed to render it', () => {
    const entry = routeEntry({ name: 'Commute', waypoints, profile: 'trekking', gpx: '<gpx/>', route })
    expect(entry.distanceM).toBe(route.distanceM)
    expect(entry.ascentM).toBe(route.ascendM)
    expect(entry.timeS).toBe(route.timeS)
    expect(entry.preview.length).toBeGreaterThan(1)
  })

  it('falls back to a generated name rather than saving something called ""', () => {
    const entry = routeEntry({ name: '   ', waypoints, profile: 'trekking', gpx: '<gpx/>', route })
    expect(entry.name.trim()).not.toBe('')
    expect(entry.name).toContain('km')
  })

  it('keeps the GPX verbatim, because that is what the map and Export both read', () => {
    const gpx = fixture('urban-short.gpx')
    const entry = routeEntry({ name: 'x', waypoints, profile: 'gravel', gpx, route })
    expect(entry.gpx).toBe(gpx)
    expect(entry.profile).toBe('gravel')
    expect(entry.waypoints).toEqual(waypoints)
  })
})

describe('byNewest', () => {
  it('puts the most recently saved first', () => {
    const entries = [{ savedAt: 100 }, { savedAt: 300 }, { savedAt: 200 }]
    expect(byNewest(entries).map((e) => e.savedAt)).toEqual([300, 200, 100])
  })

  it('does not reorder the caller’s array', () => {
    const entries = [{ savedAt: 100 }, { savedAt: 300 }]
    byNewest(entries)
    expect(entries[0].savedAt).toBe(100)
  })
})

describe('filterEntries', () => {
  const entries = [
    { kind: 'ride' as const, id: 'a' },
    { kind: 'route' as const, id: 'b' },
    { kind: 'ride' as const, id: 'c' },
  ]

  it('leaves the mixed list alone, which is the default and the useful order', () => {
    expect(filterEntries(entries, 'all')).toEqual(entries)
  })

  it('shows only what was planned', () => {
    expect(filterEntries(entries, 'route').map((e) => e.id)).toEqual(['b'])
  })

  it('shows only what was ridden', () => {
    expect(filterEntries(entries, 'ride').map((e) => e.id)).toEqual(['a', 'c'])
  })
})

describe('renamed', () => {
  const entry = rideEntry({
    name: '',
    summary: summarise(startRecording(Date.UTC(2026, 8, 8, 17, 0))),
    gpx: '<gpx/>',
    trace: [
      { lon: -3.2, lat: 55.9, elevM: 60, at: 0 },
      { lon: -3.1, lat: 55.9, elevM: 62, at: 1000 },
    ],
  })

  it('takes the new name', () => {
    expect(renamed(entry, '  Pentlands loop ').name).toBe('Pentlands loop')
  })

  it('keeps the old name rather than leaving a row with no label', () => {
    expect(renamed(entry, '   ').name).toBe(entry.name)
  })

  it('changes nothing else, so a rename cannot lose the track', () => {
    const next = renamed(entry, 'Commute')
    expect(next.id).toBe(entry.id)
    expect(next.gpx).toBe(entry.gpx)
    expect(next.summary).toBe(entry.summary)
  })
})

/**
 * A history is a list of rides; stats are what a rider actually wants out of one. The month
 * boundary is the part worth testing, because it is the part you otherwise find out about on
 * the first of the month.
 */
describe('rideTotals', () => {
  const ride = (at: number, distanceM: number, ascentM = 100, movingS = 3600): SavedRide => ({
    id: String(at),
    name: 'x',
    savedAt: at,
    kind: 'ride',
    gpx: '',
    preview: [],
    summary: {
      startedAt: at,
      endedAt: at + movingS * 1000,
      elapsedS: movingS,
      movingS,
      distanceM,
      ascentM,
      energyKj: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      avgPowerW: null,
    },
  })

  const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime()
  const thisMonth = new Date(2026, 8, 2).getTime()
  const lastMonth = new Date(2026, 7, 28).getTime()

  it('adds up everything, and this month separately', () => {
    const totals = rideTotals([ride(thisMonth, 20_000), ride(lastMonth, 30_000)], NOW)
    expect(totals.all.rides).toBe(2)
    expect(totals.all.distanceM).toBe(50_000)
    expect(totals.month.rides).toBe(1)
    expect(totals.month.distanceM).toBe(20_000)
  })

  it('counts a ride from the first of the month', () => {
    // The boundary is midnight local, not UTC: a Sunday morning ride on the 1st belongs to the
    // month it was ridden in.
    const first = new Date(2026, 8, 1, 0, 30).getTime()
    expect(rideTotals([ride(first, 1000)], NOW).month.rides).toBe(1)
  })

  it('excludes a ride from the last minute of the previous month', () => {
    const before = new Date(2026, 7, 31, 23, 59).getTime()
    expect(rideTotals([ride(before, 1000)], NOW).month.rides).toBe(0)
  })

  it('counts a ride by when it was ridden, not when it was filed', () => {
    // They are the same number today. If a rename or a later save ever moves `savedAt`, a
    // September ride must not become an October one.
    const entry = { ...ride(lastMonth, 5000), savedAt: thisMonth }
    expect(rideTotals([entry], NOW).month.rides).toBe(0)
  })

  it('reports zeroes rather than nothing for a month with no rides', () => {
    const totals = rideTotals([], NOW)
    expect(totals.all).toEqual({ rides: 0, distanceM: 0, ascentM: 0, movingS: 0 })
    expect(totals.monthLabel.length).toBeGreaterThan(2)
  })
})
