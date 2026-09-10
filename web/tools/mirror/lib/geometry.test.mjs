import { describe, expect, it } from 'vitest'
import { segmentsForBbox } from './geometry.mjs'
import { tilesForBbox } from '../../../src/engine/tiles'

describe('segmentsForBbox', () => {
  it('names the single segment a Central Belt box sits inside', () => {
    expect(segmentsForBbox([-5.0, 55.4, -2.4, 56.3])).toEqual(['W5_N55'])
  })

  it('names both segments when a box straddles the 55th parallel', () => {
    expect(segmentsForBbox([-3.5, 54.5, -2.5, 55.5])).toEqual(['W5_N50', 'W5_N55'])
  })

  it('agrees with the app geometry it must not drift from', () => {
    const boxes = [
      [-5.0, 55.4, -2.4, 56.3],
      [-0.5, 51.3, 0.3, 51.7],
      [-8.7, 49.8, 2.0, 61.0],
      [-3.5, 54.5, -2.5, 55.5],
      // Edge case: south polar region (lat < -90) should return empty
      [-5.0, -95.0, -2.0, -88.0],
      // Edge case: antimeridian crossing (west > east)
      [170, 50, -170, 60],
      // Edge case: north polar region (lat > 80) should skip invalid tiles
      [0, 85, 5, 90],
    ]
    for (const [west, south, east, north] of boxes) {
      expect(segmentsForBbox([west, south, east, north]))
        .toEqual([...tilesForBbox({ west, south, east, north })].sort())
    }
  })
})
