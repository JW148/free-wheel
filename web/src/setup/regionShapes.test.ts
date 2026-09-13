import { describe, expect, it } from 'vitest'
import type { RegionEntry } from '../data/manifest'
import {
  CELL_DEGREES,
  REGION_SEEDS,
  partitionRegions,
  seedsFor,
  spread,
  type Rect,
} from './regionShapes'

const region = (id: string, bbox: [number, number, number, number]): RegionEntry => ({
  id,
  name: id,
  bbox,
  basemap: { url: `regions/${id}.pmtiles`, bytes: 1, hash: id, built: '2026-09-08' },
  segments: ['W5_N55'],
})

/** The published list, so the tests measure the shapes the app actually draws. */
const PUBLISHED: RegionEntry[] = [
  region('highlands-islands', [-7.7, 56.3, -1.6, 59.5]),
  region('central-scotland', [-6.6, 55.3, -2.4, 56.4]),
  region('southern-scotland', [-5.0, 54.6, -1.6, 56.0]),
  region('north-east-england', [-2.7, 54.0, -0.7, 55.5]),
  region('north-west-england', [-4.9, 53.2, -2.0, 55.0]),
  region('yorkshire', [-2.6, 53.3, -0.1, 54.6]),
  region('north-wales', [-5.4, 52.4, -2.6, 53.5]),
  region('south-wales', [-5.4, 51.3, -2.6, 52.5]),
  region('midlands', [-2.8, 52.0, -0.5, 53.4]),
  region('east-anglia', [-0.6, 51.9, 1.8, 53.9]),
  region('south-west-england', [-5.8, 50.0, -2.4, 51.5]),
  region('wessex', [-2.6, 50.5, -0.7, 52.1]),
  region('london-home-counties', [-1.0, 51.2, 1.4, 52.1]),
  region('kent-sussex', [-0.9, 50.6, 1.6, 51.5]),
]

const area = (rects: Rect[]) =>
  rects.reduce((sum, [w, s, e, n]) => sum + (e - w) * (n - s), 0)

/** Which region a point is painted as, by looking it up in the rectangles. */
function paintedAt(shapes: ReturnType<typeof partitionRegions>, lon: number, lat: number) {
  const hits = shapes.filter((shape) =>
    shape.rects.some(([w, s, e, n]) => lon >= w && lon < e && lat >= s && lat < n),
  )
  return hits.map((shape) => shape.id)
}

describe('spread', () => {
  it('scales longitude by the cosine of the latitude', () => {
    // A degree of longitude at 60°N is barely half a degree of latitude on the ground, so a
    // point one degree east is *nearer* than one a degree north.
    expect(spread([0, 60], [1, 60])).toBeLessThan(spread([0, 60], [0, 61]))
  })

  it('is zero at the seed itself, which is what keeps a seed inside its own region', () => {
    expect(spread([-3.2, 55.9], [-3.2, 55.9])).toBe(0)
  })
})

describe('seedsFor', () => {
  it('gives every published region a seed', () => {
    for (const entry of PUBLISHED) {
      expect(REGION_SEEDS[entry.id], entry.id).toBeDefined()
    }
  })

  it('keeps every seed inside its own published box, so it can never claim coverage', () => {
    for (const entry of PUBLISHED) {
      for (const [lon, lat] of seedsFor(entry)) {
        const [west, south, east, north] = entry.bbox
        expect(lon, entry.id).toBeGreaterThanOrEqual(west)
        expect(lon, entry.id).toBeLessThanOrEqual(east)
        expect(lat, entry.id).toBeGreaterThanOrEqual(south)
        expect(lat, entry.id).toBeLessThanOrEqual(north)
      }
    }
  })

  it('falls back to the box centre for a region it has never heard of', () => {
    expect(seedsFor(region('outer-hebrides', [-8, 57, -6, 58]))).toEqual([[-7, 57.5]])
  })
})

describe('partitionRegions', () => {
  const shapes = partitionRegions(PUBLISHED)

  it('gives every published region an area to point at', () => {
    expect(shapes).toHaveLength(PUBLISHED.length)
    for (const shape of shapes) {
      expect(shape.rects.length, shape.id).toBeGreaterThan(0)
      expect(area(shape.rects), shape.id).toBeGreaterThan(0.5)
    }
  })

  it('never paints one place as two regions, which is the whole point', () => {
    for (let lon = -7.5; lon < 1.8; lon += 0.25) {
      for (let lat = 50.1; lat < 59.5; lat += 0.25) {
        expect(paintedAt(shapes, lon, lat).length, `${lon}, ${lat}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('paints nothing outside the region that claims it', () => {
    for (const shape of shapes) {
      const box = PUBLISHED.find((r) => r.id === shape.id)!.bbox
      for (const [w, s, e, n] of shape.rects) {
        // A half-cell of slack in each direction: ownership is decided at the cell centre, so
        // a box edge that falls inside a cell rounds to the nearer cell boundary.
        expect(w, shape.id).toBeGreaterThanOrEqual(box[0] - CELL_DEGREES)
        expect(s, shape.id).toBeGreaterThanOrEqual(box[1] - CELL_DEGREES)
        expect(e, shape.id).toBeLessThanOrEqual(box[2] + CELL_DEGREES)
        expect(n, shape.id).toBeLessThanOrEqual(box[3] + CELL_DEGREES)
      }
    }
  })

  it('covers everywhere at least one region covers', () => {
    for (const entry of PUBLISHED) {
      const [w, s, e, n] = entry.bbox
      // Sampled well inside the box, so the half-cell rounding above cannot account for a miss.
      for (let lon = w + 0.3; lon < e - 0.3; lon += 0.3) {
        for (let lat = s + 0.3; lat < n - 0.3; lat += 0.3) {
          expect(paintedAt(shapes, lon, lat), `${lon}, ${lat}`).toHaveLength(1)
        }
      }
    }
  })

  /**
   * The case that disqualified nearest-centre.
   *
   * Both boxes hold the Central Belt. Nearest bbox centre put the divide north of Edinburgh —
   * Southern Scotland's box is tall, Central's is wide, and the midpoint between the two
   * centres has nothing to do with which region a rider would say they were in.
   */
  it('puts the Central Belt in Central Scotland, not the Borders', () => {
    expect(paintedAt(shapes, -4.25, 55.86)).toEqual(['central-scotland']) // Glasgow
    expect(paintedAt(shapes, -3.19, 55.95)).toEqual(['central-scotland']) // Edinburgh
    expect(paintedAt(shapes, -2.8, 55.2)).toEqual(['southern-scotland']) // the Borders
  })

  it('puts the obvious cities in the region a rider would name', () => {
    expect(paintedAt(shapes, -0.13, 51.51)).toEqual(['london-home-counties']) // London
    expect(paintedAt(shapes, -1.55, 53.8)).toEqual(['yorkshire']) // Leeds
    expect(paintedAt(shapes, -2.24, 53.48)).toEqual(['north-west-england']) // Manchester
    expect(paintedAt(shapes, -3.18, 51.48)).toEqual(['south-wales']) // Cardiff
    expect(paintedAt(shapes, -1.9, 52.48)).toEqual(['midlands']) // Birmingham
    expect(paintedAt(shapes, -5.05, 50.26)).toEqual(['south-west-england']) // Penzance
    expect(paintedAt(shapes, 1.3, 52.63)).toEqual(['east-anglia']) // Norwich
    expect(paintedAt(shapes, 0.52, 51.27)).toEqual(['kent-sussex']) // Maidstone
    expect(paintedAt(shapes, -4.14, 57.48)).toEqual(['highlands-islands']) // Inverness
  })

  it('merges cells rather than handing MapLibre one rectangle per cell', () => {
    // Around nine thousand cells go in. Anything remotely near that number coming out means
    // the merge is not running, and a fill layer of nine thousand slivers shows its own seams.
    const total = shapes.reduce((sum, shape) => sum + shape.rects.length, 0)
    expect(total).toBeLessThan(400)
  })

  it('draws an outline only where two regions meet or the coverage ends', () => {
    for (const shape of shapes) {
      expect(shape.edges.length, shape.id).toBeGreaterThan(0)
      for (const run of shape.edges) {
        expect(run).toHaveLength(2)
        const [[x1, y1], [x2, y2]] = run
        // Axis-aligned, and never zero length.
        expect(x1 === x2 || y1 === y2).toBe(true)
        expect(x1 !== x2 || y1 !== y2).toBe(true)
      }
    }
  })

  it('anchors each name inside its own region', () => {
    for (const shape of shapes) {
      const [lon, lat] = shape.anchor
      expect(paintedAt(shapes, lon, lat), shape.id).toEqual([shape.id])
    }
  })

  it('answers an empty list with an empty partition rather than a grid of nothing', () => {
    expect(partitionRegions([])).toEqual([])
  })

  it('leaves a lone region whole', () => {
    const [only] = partitionRegions([region('solo', [-3, 55, -1, 56])])
    expect(only.rects).toHaveLength(1)
    expect(area(only.rects)).toBeCloseTo(2, 5)
  })
})
