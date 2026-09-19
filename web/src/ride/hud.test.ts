import { describe, expect, it } from 'vitest'
import type { Gradient, GradientAhead } from './climbs'
import {
  calloutFor,
  calloutMatters,
  compactFigures,
  figuresFor,
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
