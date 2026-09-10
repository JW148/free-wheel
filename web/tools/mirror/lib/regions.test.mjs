import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { segmentsForBbox } from './geometry.mjs'

const regions = JSON.parse(readFileSync(new URL('../regions.json', import.meta.url), 'utf8'))

describe('regions.json', () => {
  it('gives every region a unique id and a name', () => {
    const ids = regions.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const region of regions) {
      expect(region.id).toMatch(/^[a-z0-9-]+$/)
      expect(region.name.length).toBeGreaterThan(2)
    }
  })

  it('orders every bbox west, south, east, north', () => {
    for (const { id, bbox } of regions) {
      const [west, south, east, north] = bbox
      expect(west, id).toBeLessThan(east)
      expect(south, id).toBeLessThan(north)
    }
  })

  it('covers Edinburgh, Bristol, central London and other major cities', () => {
    const covers = (lon, lat) =>
      regions.some(({ bbox: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n)
    expect(covers(-3.19, 55.95), 'Edinburgh').toBe(true)
    expect(covers(-2.59, 51.45), 'Bristol').toBe(true)
    expect(covers(-0.12, 51.51), 'London').toBe(true)
    expect(covers(-4.25, 55.86), 'Glasgow').toBe(true)
    expect(covers(-4.22, 57.48), 'Inverness').toBe(true)
    expect(covers(-1.61, 54.97), 'Newcastle').toBe(true)
    expect(covers(-2.24, 53.48), 'Manchester').toBe(true)
    expect(covers(-3.18, 51.48), 'Cardiff').toBe(true)
    expect(covers(-4.08, 52.41), 'Aberystwyth').toBe(true)
    expect(covers(-4.14, 50.37), 'Plymouth').toBe(true)
    expect(covers(1.30, 52.63), 'Norwich').toBe(true)
  })

  it('needs at most two segments per region, so no download carries a spare 137 MB', () => {
    for (const region of regions) {
      expect(segmentsForBbox(region.bbox).length, region.id).toBeLessThanOrEqual(2)
    }
  })
})
