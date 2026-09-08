import { describe, expect, it } from 'vitest'
import { angleGap, haversineM, shortestTurn } from './geo'

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

describe('shortestTurn', () => {
  it('turns 20° forwards rather than 340° backwards', () => {
    expect(shortestTurn(350, 10)).toBeCloseTo(370, 6)
  })

  it('turns backwards where backwards is shorter', () => {
    expect(shortestTurn(10, 350)).toBeCloseTo(-10, 6)
  })

  it('leaves a bearing that needs no wrapping alone', () => {
    expect(shortestTurn(90, 120)).toBeCloseTo(120, 6)
  })

  it('never asks for a turn of more than half a revolution', () => {
    for (let from = -400; from <= 400; from += 37) {
      for (let to = 0; to < 360; to += 13) {
        expect(Math.abs(shortestTurn(from, to) - from)).toBeLessThanOrEqual(180.000001)
      }
    }
  })

  it('lands on a bearing equivalent to the one asked for', () => {
    for (let to = 0; to < 360; to += 17) {
      expect(((shortestTurn(350, to) % 360) + 360) % 360).toBeCloseTo(to, 6)
    }
  })
})
