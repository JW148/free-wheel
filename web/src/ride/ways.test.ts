import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx } from './gpx'
import { routeGeometry } from './progress'
import {
  breakdownOf,
  classifyRoad,
  classifySurface,
  markedRuns,
  ROAD_CLASSES,
  SURFACE_CLASSES,
  wayRuns,
} from './ways'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

const short = parseBrouterGpx(fixture('urban-short.gpx'))
const long = parseBrouterGpx(fixture('london-brighton.gpx'))
const plain = parseBrouterGpx(fixture('urban-short-plain.gpx'))

describe('classifySurface', () => {
  it('reads the common paved values', () => {
    expect(classifySurface({ surface: 'asphalt' })).toBe('paved')
    expect(classifySurface({ surface: 'concrete' })).toBe('paved')
    expect(classifySurface({ surface: 'paving_stones' })).toBe('paved')
  })

  it('calls cobbles and setts rough, not loose', () => {
    // They are paved — a sett road is not a gravel track — but the rider's question is
    // whether it will be slow and jarring, and the answer there is the same.
    expect(classifySurface({ surface: 'sett' })).toBe('rough')
    expect(classifySurface({ surface: 'cobblestone' })).toBe('rough')
  })

  it('calls everything unbound loose', () => {
    for (const value of ['gravel', 'ground', 'dirt', 'grass', 'sand', 'mud', 'unpaved']) {
      expect(classifySurface({ surface: value })).toBe('loose')
    }
  })

  it('falls back to tracktype when surface is missing', () => {
    expect(classifySurface({ tracktype: 'grade1' })).toBe('paved')
    expect(classifySurface({ tracktype: 'grade2' })).toBe('loose')
    expect(classifySurface({ tracktype: 'grade5' })).toBe('loose')
  })

  it('prefers an explicit surface over the tracktype', () => {
    expect(classifySurface({ surface: 'asphalt', tracktype: 'grade4' })).toBe('paved')
  })

  it('says unknown rather than guessing', () => {
    // Untagged is a fact about the map, not about the road, and a guess here becomes a
    // dashed line on the map claiming a road is rough when nobody knows.
    expect(classifySurface({ highway: 'residential' })).toBe('unknown')
    expect(classifySurface({})).toBe('unknown')
  })

  it('does not choke on a value it has never seen', () => {
    expect(classifySurface({ surface: 'unobtainium' })).toBe('unknown')
  })
})

describe('classifyRoad', () => {
  it('names a cycleway', () => {
    expect(classifyRoad({ highway: 'cycleway' })).toBe('cyclepath')
  })

  it('groups the unsurfaced ways as paths', () => {
    for (const value of ['path', 'track', 'bridleway', 'footway', 'steps', 'pedestrian']) {
      expect(classifyRoad({ highway: value })).toBe('path')
    }
  })

  it('treats tertiary as an ordinary road', () => {
    // A British tertiary is a lane. Calling it a main road would put a caution stripe over
    // most of the countryside.
    expect(classifyRoad({ highway: 'tertiary' })).toBe('road')
    expect(classifyRoad({ highway: 'tertiary_link' })).toBe('road')
    expect(classifyRoad({ highway: 'residential' })).toBe('road')
    expect(classifyRoad({ highway: 'unclassified' })).toBe('road')
    expect(classifyRoad({ highway: 'living_street' })).toBe('road')
  })

  it('names the roads worth being wary of', () => {
    for (const value of ['primary', 'secondary', 'trunk', 'primary_link', 'trunk_link']) {
      expect(classifyRoad({ highway: value })).toBe('main')
    }
  })

  it('falls back to road for a highway value it has never seen', () => {
    // Never `main`: inventing a caution is worse than missing one, because the mark is
    // supposed to mean something the first time it appears.
    expect(classifyRoad({ highway: 'busway' })).toBe('road')
    expect(classifyRoad({})).toBe('road')
  })
})

describe('wayRuns', () => {
  const geometry = routeGeometry(short)!
  const runs = wayRuns(short, geometry)!

  it('tiles the whole route with no gaps and no overlaps', () => {
    expect(runs[0].fromM).toBe(0)
    expect(runs.at(-1)!.toM).toBeCloseTo(geometry.totalM, 6)
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].fromM).toBe(runs[i - 1].toM)
    }
  })

  it('starts the first run at the start, not at the first tag', () => {
    // BRouter's first <brouter:way> lands on the second track point, because the first is
    // the snap onto the network. Leaving those few metres unattributed would put a gap in
    // the strip at the one end a rider is looking at.
    expect(short.ways![0].index).toBeGreaterThan(0)
    expect(runs[0].fromM).toBe(0)
  })

  it('gives every run a positive length', () => {
    for (const run of runs) expect(run.toM).toBeGreaterThan(run.fromM)
  })

  it('carries the classification alongside the raw tags', () => {
    const cycleway = runs.find((r) => r.road === 'cyclepath')
    if (cycleway) expect(cycleway.tags.highway).toBe('cycleway')
    for (const run of runs) {
      expect(ROAD_CLASSES).toContain(run.road)
      expect(SURFACE_CLASSES).toContain(run.surface)
    }
  })

  it('is absent for a route that carries no ways at all', () => {
    expect(wayRuns(plain, routeGeometry(plain)!)).toBeNull()
  })

  it('handles a long route', () => {
    const runsLong = wayRuns(long, routeGeometry(long)!)!
    expect(runsLong.length).toBeGreaterThan(100)
    expect(runsLong.at(-1)!.toM).toBeCloseTo(routeGeometry(long)!.totalM, 6)
  })
})

describe('breakdownOf', () => {
  const geometry = routeGeometry(long)!
  const runs = wayRuns(long, geometry)!
  const breakdown = breakdownOf(runs)

  it('totals the road classes to the route length', () => {
    const summed = breakdown.road.reduce((total, row) => total + row.metres, 0)
    expect(summed).toBeCloseTo(geometry.totalM, 3)
  })

  it('totals the surface classes to the route length', () => {
    const summed = breakdown.surface.reduce((total, row) => total + row.metres, 0)
    expect(summed).toBeCloseTo(geometry.totalM, 3)
  })

  it('sorts each table longest first', () => {
    for (const table of [breakdown.road, breakdown.surface]) {
      const metres = table.map((row) => row.metres)
      expect(metres).toEqual([...metres].sort((a, b) => b - a))
    }
  })

  it('measures the cycle network from the routing tiles', () => {
    // route_bicycle_ncn is in lookups.dat and therefore in every .rd5 on the phone, which
    // is the one place this fact exists — the basemap archive carries no route relations.
    expect(breakdown.networkM).toBeGreaterThanOrEqual(0)
    expect(breakdown.networkM).toBeLessThanOrEqual(geometry.totalM)
  })

  it('counts a way on any national or regional network, but not a local one', () => {
    const on = (tags: Record<string, string>) =>
      breakdownOf([{ fromM: 0, toM: 100, tags, road: 'road', surface: 'paved' }]).networkM

    expect(on({ route_bicycle_ncn: 'yes' })).toBe(100)
    expect(on({ route_bicycle_rcn: 'yes' })).toBe(100)
    expect(on({ route_bicycle_icn: 'yes' })).toBe(100)
    // lcn is a council's own signage, not the National Cycle Network, and the line names
    // the NCN. Counting it would overstate by a lot in any town.
    expect(on({ route_bicycle_lcn: 'yes' })).toBe(0)
    expect(on({ route_bicycle_ncn: 'proposed' })).toBe(0)
  })

  it('folds the tail into one Other row rather than listing twelve', () => {
    const rows = [
      { metres: 1000, key: 'a' },
      { metres: 900, key: 'b' },
      { metres: 800, key: 'c' },
      { metres: 700, key: 'd' },
      { metres: 600, key: 'e' },
      { metres: 500, key: 'f' },
    ].map((r, i) => ({
      fromM: i * 100,
      toM: i * 100 + r.metres,
      tags: { highway: ['cycleway', 'path', 'residential', 'primary', 'busway', 'service'][i] },
      road: (['cyclepath', 'path', 'road', 'main', 'road', 'road'] as const)[i],
      surface: 'paved' as const,
    }))
    const folded = breakdownOf(rows, 2)
    expect(folded.road).toHaveLength(3)
    expect(folded.road.at(-1)!.label).toBe('Other')
  })

  it('carries the class key as well as the label, so the table can be the legend', () => {
    // Four coloured bands above a table of the same four words is a puzzle. The swatch is
    // what solves it, and it needs the key rather than the English.
    for (const row of breakdown.road) {
      expect(row.key).toBeTruthy()
      if (row.key !== 'other') expect(ROAD_CLASSES).toContain(row.key)
    }
  })

  it('drops a class with no distance rather than showing a zero row', () => {
    const one = breakdownOf([
      { fromM: 0, toM: 100, tags: { highway: 'cycleway' }, road: 'cyclepath', surface: 'paved' },
    ])
    expect(one.road).toHaveLength(1)
    expect(one.surface).toHaveLength(1)
  })
})

describe('markedRuns', () => {
  it('marks loose and rough alike, and leaves paved alone', () => {
    // Loose and rough carry the same mark, so touching stretches of the two come back as one
    // run from 100 to 300 rather than two. The paved head and the unknown tail get nothing.
    const marks = markedRuns([
      { fromM: 0, toM: 100, tags: {}, road: 'road', surface: 'paved' },
      { fromM: 100, toM: 200, tags: {}, road: 'road', surface: 'loose' },
      { fromM: 200, toM: 300, tags: {}, road: 'road', surface: 'rough' },
      { fromM: 300, toM: 400, tags: {}, road: 'road', surface: 'unknown' },
    ])
    expect(marks).toEqual([{ fromM: 100, toM: 300, mark: 'unpaved' }])
  })

  it('never marks an unknown surface', () => {
    // Same rule as the classifier: untagged is not a claim that the road is rough.
    const marks = markedRuns([
      { fromM: 0, toM: 100, tags: {}, road: 'road', surface: 'unknown' },
    ])
    expect(marks).toHaveLength(0)
  })

  it('marks a main road', () => {
    const marks = markedRuns([
      { fromM: 0, toM: 100, tags: {}, road: 'main', surface: 'paved' },
    ])
    expect(marks).toEqual([{ fromM: 0, toM: 100, mark: 'main' }])
  })

  it('emits both marks for a main road that is also unpaved', () => {
    // They are different layers on the map — a casing under the line and a dash over it —
    // so a stretch that is both gets both, rather than one winning.
    const marks = markedRuns([
      { fromM: 0, toM: 100, tags: {}, road: 'main', surface: 'loose' },
    ])
    expect(marks.map((m) => m.mark).sort()).toEqual(['main', 'unpaved'])
  })

  it('merges neighbouring runs carrying the same mark', () => {
    // The tags change constantly — a surface value appearing is enough — and drawing 400
    // touching dashes instead of one leaves a seam at every join.
    const marks = markedRuns([
      { fromM: 0, toM: 100, tags: {}, road: 'road', surface: 'loose' },
      { fromM: 100, toM: 250, tags: {}, road: 'road', surface: 'rough' },
      { fromM: 250, toM: 300, tags: {}, road: 'road', surface: 'paved' },
      { fromM: 300, toM: 400, tags: {}, road: 'road', surface: 'loose' },
    ])
    expect(marks).toEqual([
      { fromM: 0, toM: 250, mark: 'unpaved' },
      { fromM: 300, toM: 400, mark: 'unpaved' },
    ])
  })

  it('finds something to mark on a real route', () => {
    const runs = wayRuns(long, routeGeometry(long)!)!
    const marks = markedRuns(runs)
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) expect(mark.toM).toBeGreaterThan(mark.fromM)
  })
})
