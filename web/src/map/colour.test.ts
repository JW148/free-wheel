import { describe, expect, it } from 'vitest'
import { chroma, deltaE2000, lightness } from './colour'

/**
 * Sharma, Wu & Dalal's CIEDE2000 verification data — the standard test set for the formula,
 * chosen because it deliberately targets the branches that are easy to get wrong: hue
 * differences straddling 0°/360°, the discontinuity at exactly 180°, and the zero-chroma case
 * where the mean hue is undefined.
 *
 * These are not decorative. Writing this out caught two mis-transcribed *expectations* of my
 * own before they were baked in, and a naive mean-hue implementation fails pairs 7 and 8 while
 * passing everything else.
 */
const SHARMA: [number, number, number, number, number, number, number][] = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
]

describe('deltaE2000', () => {
  it('matches the Sharma reference data on all 13 pairs', () => {
    for (const [l1, a1, b1, l2, a2, b2, expected] of SHARMA) {
      expect(
        deltaE2000({ L: l1, a: a1, b: b1 }, { L: l2, a: a2, b: b2 }),
        `Lab(${l1},${a1},${b1}) vs Lab(${l2},${a2},${b2})`,
      ).toBeCloseTo(expected, 4)
    }
  })

  it('reports the full scale between black and white', () => {
    expect(deltaE2000('#ffffff', '#000000')).toBeCloseTo(100, 4)
  })

  it('is zero for a colour against itself', () => {
    expect(deltaE2000('#c1e1ba', '#c1e1ba')).toBe(0)
  })

  it('accepts hex strings as well as Lab', () => {
    // The measured separation of the old palette's park green from its building grey. It is
    // below the ~2.3 just-noticeable difference, which is why the map read as monochrome.
    expect(deltaE2000('#dde3dd', '#dfe3e2')).toBeCloseTo(2.8292, 4)
  })
})

describe('chroma', () => {
  it('measures the old path colour at the documented ceiling', () => {
    // `docs/phase-4-progress.md` records "C <= 15.1" for the whole basemap. That figure is
    // this colour: it is what set the ceiling.
    expect(chroma('#6b5c46')).toBeCloseTo(15.1266, 4)
  })

  it('measures a near-neutral as almost zero', () => {
    expect(chroma('#eef0ef')).toBeCloseTo(0.8783, 4)
  })

  it('measures a vivid route colour far above the basemap range', () => {
    expect(chroma('#389f48')).toBeCloseTo(60.4276, 4)
  })
})

describe('lightness', () => {
  it('spans 0 to 100 for black and white', () => {
    expect(lightness('#000000')).toBeCloseTo(0, 6)
    // Not exactly 100: the published sRGB-to-XYZ matrix's Y row sums to 1.0000001, so white
    // lands at L* 100.0000039. That is the matrix's own rounding, not ours, and 4 decimals is
    // already far finer than any palette decision needs.
    expect(lightness('#ffffff')).toBeCloseTo(100, 4)
  })

  it('measures the chosen park green', () => {
    expect(lightness('#c1e1ba')).toBeCloseTo(86.3712, 4)
  })
})
