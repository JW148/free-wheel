import { describe, expect, it } from 'vitest'
import { pendingVerdict, sheetProgress, sheetRelease, wasTap } from './sheetDrag'

const RANGE = 400

describe('sheetProgress', () => {
  it('is 0 at rest on the card and 1 at rest open', () => {
    expect(sheetProgress({ from: 'card', travelledPx: 0, rangePx: RANGE })).toBe(0)
    expect(sheetProgress({ from: 'open', travelledPx: 0, rangePx: RANGE })).toBe(1)
  })

  it('tracks the finger between the two', () => {
    expect(sheetProgress({ from: 'card', travelledPx: 100, rangePx: RANGE })).toBe(0.25)
    expect(sheetProgress({ from: 'open', travelledPx: -100, rangePx: RANGE })).toBe(0.75)
  })

  it('clamps rather than letting the sheet overshoot either stop', () => {
    expect(sheetProgress({ from: 'card', travelledPx: 900, rangePx: RANGE })).toBe(1)
    expect(sheetProgress({ from: 'open', travelledPx: -900, rangePx: RANGE })).toBe(0)
    expect(sheetProgress({ from: 'card', travelledPx: -50, rangePx: RANGE })).toBe(0)
  })

  // Before either height is measured the two stops are the same place. Dividing by that is a
  // NaN written into a CSS variable, which silently drops every rule that reads it.
  it('survives a zero range', () => {
    expect(sheetProgress({ from: 'card', travelledPx: 30, rangePx: 0 })).toBe(0)
    expect(sheetProgress({ from: 'open', travelledPx: -30, rangePx: 0 })).toBe(1)
  })
})

describe('wasTap', () => {
  it('forgives the pixel or two a thumb moves while pressing', () => {
    expect(wasTap(0)).toBe(true)
    expect(wasTap(-4)).toBe(true)
    expect(wasTap(40)).toBe(false)
  })
})

describe('sheetRelease', () => {
  const release = (over: Partial<Parameters<typeof sheetRelease>[0]> = {}) =>
    sheetRelease({ from: 'card', travelledPx: 0, velocityPxPerS: 0, rangePx: RANGE, ...over })

  it('treats a still release as a tap, which toggles', () => {
    expect(release({ from: 'card' })).toBe('open')
    expect(release({ from: 'open' })).toBe('card')
  })

  it('treats a release under the slop as a tap too', () => {
    // A thumb never holds perfectly still. Four pixels is a tap, not a drag that changed its
    // mind — and without this the handle would need a pixel-perfect press to open the sheet.
    expect(release({ from: 'card', travelledPx: 4 })).toBe('open')
    expect(release({ from: 'card', travelledPx: -4 })).toBe('open')
  })

  it('settles to whichever stop is nearer', () => {
    expect(release({ from: 'card', travelledPx: 90 })).toBe('card')
    expect(release({ from: 'card', travelledPx: 260 })).toBe('open')
    expect(release({ from: 'open', travelledPx: -90 })).toBe('open')
    expect(release({ from: 'open', travelledPx: -260 })).toBe('card')
  })

  it('opens on a flick the distance would have sent back', () => {
    expect(release({ from: 'card', travelledPx: 40, velocityPxPerS: 900 })).toBe('open')
  })

  it('closes on a flick the distance would have opened', () => {
    // The rider changed their mind on the way up. Direction of travel at the moment they let
    // go is the more recent statement of intent, so it beats how far they got.
    expect(release({ from: 'card', travelledPx: 340, velocityPxPerS: -900 })).toBe('card')
    expect(release({ from: 'open', travelledPx: -40, velocityPxPerS: -900 })).toBe('card')
  })

  it('ignores a drift too slow to be a flick', () => {
    expect(release({ from: 'card', travelledPx: 90, velocityPxPerS: 120 })).toBe('card')
  })

  it('holds its ground when the range is unmeasurable', () => {
    expect(release({ from: 'open', travelledPx: -80, rangePx: 0 })).toBe('open')
  })
})

/**
 * A press inside the open sheet's body is three gestures wearing one costume: a drag that
 * shuts the sheet, a scroll, and a tap on whichever route card is under the thumb. These are
 * the first dozen pixels that tell them apart.
 */
describe('pendingVerdict', () => {
  it('says nothing until the finger has committed to something', () => {
    expect(pendingVerdict(0, 0)).toBe('wait')
    expect(pendingVerdict(3, -6)).toBe('wait')
  })

  it('becomes a drag on a deliberate pull downwards', () => {
    expect(pendingVerdict(0, -20)).toBe('drag')
  })

  it('gives an upward pull back to the scroller', () => {
    expect(pendingVerdict(0, 30)).toBe('abandon')
  })

  it('gives a sideways swipe back, however far down it also drifted', () => {
    expect(pendingVerdict(-40, -20)).toBe('abandon')
  })

  it('keeps a mostly-vertical drag that drifted sideways', () => {
    expect(pendingVerdict(-14, -30)).toBe('drag')
  })
})
