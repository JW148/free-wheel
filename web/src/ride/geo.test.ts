import { describe, expect, it } from 'vitest'
import { angleGap, haversineM } from './geo'

describe('haversineM', () => {
  it('measures a known distance', () => {
    // Edinburgh Castle to Arthur's Seat, about 2.6 km.
    const metres = haversineM([-3.2003, 55.9486], [-3.1619, 55.9444])
    expect(metres).toBeGreaterThan(2400)
    expect(metres).toBeLessThan(2800)
  })

  it('is zero for a point against itself', () => {
    expect(haversineM([-3.2, 55.9], [-3.2, 55.9])).toBe(0)
  })
})

describe('angleGap', () => {
  it('goes the short way round the circle', () => {
    expect(angleGap(350, 10)).toBeCloseTo(20, 6)
    expect(angleGap(10, 350)).toBeCloseTo(20, 6)
  })

  it('is zero for the same bearing and 180 for the opposite one', () => {
    expect(angleGap(42, 42)).toBe(0)
    expect(angleGap(0, 180)).toBe(180)
  })

  it('never exceeds 180, whatever it is handed', () => {
    for (const [a, b] of [
      [0, 359],
      [-90, 270],
      [720, 45],
      [180.5, 0.5],
    ]) {
      expect(angleGap(a, b)).toBeLessThanOrEqual(180)
      expect(angleGap(a, b)).toBeGreaterThanOrEqual(0)
    }
  })
})
