import { describe, expect, it } from 'vitest'
import type { Gradient, GradientAhead } from './climbs'
import {
  calloutFor,
  calloutMatters,
  compactFigures,
  figuresFor,
  hudPageAt,
  hudPages,
  CALLOUT_HORIZON_M,
  TURN_HORIZON_M,
} from './hud'

const gradient: Gradient = {
  kind: 'climb',
  startM: 4000,
  endM: 5000,
  lengthM: 1000,
  gainM: 60,
  grade: 0.06,
  maxGrade: 0.09,
  severity: 'hard',
}

const ahead = (over: Partial<GradientAhead>): GradientAhead => ({
  gradient,
  distanceToM: 3000,
  inIt: false,
  remainingM: 1000,
  remainingGainM: 60,
  ...over,
})

describe('calloutMatters', () => {
  it('says nothing on the strip about a climb that is still 3 km off', () => {
    expect(calloutMatters(ahead({ distanceToM: 3000 }), true)).toBe(false)
  })

  it('speaks up once the climb is inside the horizon', () => {
    expect(calloutMatters(ahead({ distanceToM: CALLOUT_HORIZON_M - 1 }), true)).toBe(true)
  })

  it('always shows the line while the rider is on the climb', () => {
    expect(calloutMatters(ahead({ inIt: true, distanceToM: 0 }), true)).toBe(true)
  })

  it('shows nothing where there is no climb left, which is the point of collapsing', () => {
    expect(calloutMatters(null, true)).toBe(false)
  })

  it('shows nothing for a track with no heights, because it cannot know', () => {
    expect(calloutMatters(ahead({ inIt: true }), false)).toBe(false)
  })
})

describe('figuresFor', () => {
  it('carries the four riding figures on a route with heights', () => {
    expect(figuresFor({ hasElevation: true })).toEqual(['speed', 'power', 'togo', 'arrive'])
  })

  it('drops power on a track with no heights rather than showing a permanent dash', () => {
    const figures = figuresFor({ hasElevation: false })
    expect(figures).not.toContain('power')
    expect(figures).toContain('togo')
  })

  it('keeps four figures either way, because every ride has a route to measure against', () => {
    expect(figuresFor({ hasElevation: true })).toHaveLength(4)
    expect(figuresFor({ hasElevation: false })).toHaveLength(4)
  })
})

describe('compactFigures', () => {
  it('keeps three, and keeps the two that answer “how much further”', () => {
    const compact = compactFigures(figuresFor({ hasElevation: true }))
    expect(compact).toEqual(['speed', 'togo', 'arrive'])
  })

  it('drops distance ridden rather than the pair that says how much is left', () => {
    const compact = compactFigures(figuresFor({ hasElevation: false }))
    expect(compact).toEqual(['speed', 'togo', 'arrive'])
  })
})

describe('calloutFor', () => {
  const climbAhead = ahead({ distanceToM: 500 })

  it('gives a near turn the line, over a climb that would otherwise have it', () => {
    // The turn is the one with a deadline. A climb announced late is still a climb coming up;
    // a turn announced late is a rider on the wrong road.
    expect(calloutFor(150, climbAhead, true)).toBe('turn')
  })

  it('leaves the line to the climb once the turn is far enough off', () => {
    expect(calloutFor(TURN_HORIZON_M + 1, climbAhead, true)).toBe('climb')
  })

  it('shows a turn even where there are no heights to describe', () => {
    // Following a recorded track that came off a computed route: no gradients and no power,
    // but the junctions are still there.
    expect(calloutFor(100, null, false)).toBe('turn')
  })

  it('shows a climb when there is no turn coming', () => {
    expect(calloutFor(null, climbAhead, true)).toBe('climb')
  })

  it('shows nothing rather than a permanent line saying nothing', () => {
    // The strip's whole argument: text appearing on it is itself the signal.
    expect(calloutFor(null, null, true)).toBeNull()
    expect(calloutFor(null, ahead({ distanceToM: CALLOUT_HORIZON_M + 1 }), true)).toBeNull()
  })

  it('takes a turn at zero distance, which is a rider on the junction', () => {
    expect(calloutFor(0, climbAhead, true)).toBe('turn')
  })
})

describe('hudPages', () => {
  it('opens onto the graph, so a rider who never swipes finds what they had', () => {
    expect(hudPages({ hasElevation: true, hasTurns: true })).toEqual(['graph', 'nav'])
  })

  it('drops the graph on a track with no surveyed heights', () => {
    // A flat chart is not "no data", it is a claim that the road ahead is level.
    expect(hudPages({ hasElevation: false, hasTurns: true })).toEqual(['nav'])
  })

  it('drops navigation on a route that carries no junctions', () => {
    // A route saved before the app asked BRouter for turn instructions, or a recorded ride.
    expect(hudPages({ hasElevation: true, hasTurns: false })).toEqual(['graph'])
  })

  it('leaves nothing to swipe between when the ride has neither', () => {
    expect(hudPages({ hasElevation: false, hasTurns: false })).toEqual([])
  })

  it('never offers a swipe it cannot honour', () => {
    // One page is not a carousel. The caller reads the length rather than re-deriving it,
    // which is the whole reason this returns an array.
    for (const hasElevation of [true, false]) {
      for (const hasTurns of [true, false]) {
        expect(hudPages({ hasElevation, hasTurns }).length).toBeLessThanOrEqual(2)
      }
    }
  })
})

describe('hudPageAt', () => {
  const both = hudPages({ hasElevation: true, hasTurns: true })

  it('reads the remembered page back', () => {
    expect(hudPageAt(both, 0)).toBe('graph')
    expect(hudPageAt(both, 1)).toBe('nav')
  })

  it('clamps a remembered page this ride does not have', () => {
    // The page persists across launches, so a rider who left it on navigation and then loads
    // a route with no junctions must land somewhere real rather than on a blank.
    expect(hudPageAt(['graph'], 1)).toBe('graph')
    expect(hudPageAt(['nav'], 5)).toBe('nav')
    expect(hudPageAt(both, -1)).toBe('graph')
  })

  it('is null when there is no page at all', () => {
    expect(hudPageAt([], 0)).toBeNull()
  })

  it('rounds a fractional index rather than landing between pages', () => {
    // `pages[0.5]` is `undefined`, which would hide both pages from a screen reader and light
    // neither dot. Nothing the app writes is fractional; this is so nothing a reader can put
    // in localStorage is either.
    expect(hudPageAt(both, 0.4)).toBe('graph')
    expect(hudPageAt(both, 0.6)).toBe('nav')
    expect(hudPageAt(both, Number.NaN)).toBe('graph')
  })
})
