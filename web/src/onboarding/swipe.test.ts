import { describe, expect, it } from 'vitest'
import { swipeOffsetPx, swipeRelease, swipeVerdict } from './swipe'

const WIDTH = 390

describe('swipeVerdict', () => {
  it('waits while the finger has said nothing', () => {
    expect(swipeVerdict(0, 0)).toBe('wait')
    expect(swipeVerdict(8, 5)).toBe('wait')
  })

  it('takes a mostly-horizontal drag', () => {
    expect(swipeVerdict(-40, 6)).toBe('swipe')
    expect(swipeVerdict(40, -20)).toBe('swipe')
  })

  it('leaves a mostly-vertical drag to the card, which scrolls', () => {
    expect(swipeVerdict(6, 40)).toBe('abandon')
  })
})

describe('swipeOffsetPx', () => {
  it('follows the finger in the middle of the deck', () => {
    expect(swipeOffsetPx(-120, 2, 5)).toBe(-120)
    expect(swipeOffsetPx(120, 2, 5)).toBe(120)
  })

  it('resists a pull past either end without deadening it', () => {
    const past = swipeOffsetPx(120, 0, 5)
    expect(past).toBeGreaterThan(0)
    expect(past).toBeLessThan(120)
    expect(swipeOffsetPx(-120, 5, 5)).toBeGreaterThan(-120)
  })

  it('still follows the finger back off an end', () => {
    // At the first card, dragging *forwards* is a real move and must not be damped.
    expect(swipeOffsetPx(-120, 0, 5)).toBe(-120)
  })
})

describe('swipeRelease', () => {
  const release = (over: Partial<Parameters<typeof swipeRelease>[0]>) =>
    swipeRelease({ index: 2, last: 5, dxPx: 0, widthPx: WIDTH, ...over })

  it('settles back when the finger barely moved', () => {
    expect(release({ dxPx: -40 })).toBe(2)
  })

  it('advances on a drag past the settle point', () => {
    expect(release({ dxPx: -140 })).toBe(3)
  })

  it('goes back on a drag the other way', () => {
    expect(release({ dxPx: 140 })).toBe(1)
  })

  it('advances on a flick the distance would have sent back', () => {
    expect(release({ dxPx: -30, velocityPxPerS: -900 })).toBe(3)
  })

  it('obeys a flick that contradicts the drag', () => {
    expect(release({ dxPx: -200, velocityPxPerS: 900 })).toBe(1)
  })

  it('cannot walk off either end of the deck', () => {
    expect(release({ index: 0, dxPx: 300 })).toBe(0)
    expect(release({ index: 5, dxPx: -300 })).toBe(5)
  })

  it('stays put when the viewport has not been measured', () => {
    expect(release({ dxPx: -140, widthPx: 0 })).toBe(2)
  })
})
