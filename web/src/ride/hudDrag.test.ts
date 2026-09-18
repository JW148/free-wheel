import { describe, expect, it } from 'vitest'
import { hudProgress, hudRelease } from './hudDrag'

/** The panel grows by about this much between the strip and the graph. */
const RANGE = 170

describe('hudProgress', () => {
  it('is 0 at rest on the strip and 1 at rest on the graph', () => {
    expect(hudProgress({ from: 'mini', travelledPx: 0, rangePx: RANGE })).toBe(0)
    expect(hudProgress({ from: 'full', travelledPx: 0, rangePx: RANGE })).toBe(1)
  })

  // Downwards is towards the graph, which is the direction the panel itself grows. The sheet
  // at the other end of the screen opens upwards, so the sign is the one thing that differs.
  it('follows a finger pulling down towards the graph', () => {
    expect(hudProgress({ from: 'mini', travelledPx: 85, rangePx: RANGE })).toBe(0.5)
    expect(hudProgress({ from: 'full', travelledPx: -85, rangePx: RANGE })).toBe(0.5)
  })

  it('clamps rather than letting the panel overshoot either size', () => {
    expect(hudProgress({ from: 'mini', travelledPx: 900, rangePx: RANGE })).toBe(1)
    expect(hudProgress({ from: 'mini', travelledPx: -40, rangePx: RANGE })).toBe(0)
    expect(hudProgress({ from: 'full', travelledPx: -900, rangePx: RANGE })).toBe(0)
  })

  it('survives a zero range, before either size has been measured', () => {
    expect(hudProgress({ from: 'mini', travelledPx: 30, rangePx: 0 })).toBe(0)
    expect(hudProgress({ from: 'full', travelledPx: -30, rangePx: 0 })).toBe(1)
  })
})

describe('hudRelease', () => {
  const release = (over: Partial<Parameters<typeof hudRelease>[0]> = {}) =>
    hudRelease({ from: 'mini', travelledPx: 0, velocityPxPerS: 0, rangePx: RANGE, ...over })

  /*
   * The difference from the plan sheet, and it is deliberate.
   *
   * The sheet's handle is a control, so a press on it has to do something. The HUD is four
   * numbers on a bicycle: the whole surface drags, which means the whole surface is also
   * under the hand that grabs the bars back. A tap that toggled would make every brush
   * against the panel swap the size of the thing being read. The chevron is the tap.
   */
  it('leaves the panel where it was when the press never moved', () => {
    expect(release({ from: 'mini' })).toBe('mini')
    expect(release({ from: 'full' })).toBe('full')
    expect(release({ from: 'full', travelledPx: 4 })).toBe('full')
  })

  it('settles to whichever size is nearer', () => {
    expect(release({ from: 'mini', travelledPx: 40 })).toBe('mini')
    expect(release({ from: 'mini', travelledPx: 120 })).toBe('full')
    expect(release({ from: 'full', travelledPx: -40 })).toBe('full')
    expect(release({ from: 'full', travelledPx: -120 })).toBe('mini')
  })

  // A flick is a statement of intent, and it beats how far the panel happened to get: a rider
  // who throws it downwards wants the graph whether or not their thumb reached half way.
  it('lets a flick overrule the distance travelled', () => {
    expect(release({ from: 'mini', travelledPx: 30, velocityPxPerS: 900 })).toBe('full')
    expect(release({ from: 'full', travelledPx: -30, velocityPxPerS: -900 })).toBe('mini')
    expect(release({ from: 'mini', travelledPx: 140, velocityPxPerS: -900 })).toBe('mini')
  })

  it('ignores a gentle drift, which is a placement rather than a throw', () => {
    expect(release({ from: 'mini', travelledPx: 30, velocityPxPerS: 200 })).toBe('mini')
  })
})
