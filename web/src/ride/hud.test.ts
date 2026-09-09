import { describe, expect, it } from 'vitest'
import type { Gradient, GradientAhead } from './climbs'
import { calloutMatters, compactFigures, figuresFor, CALLOUT_HORIZON_M } from './hud'

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
    expect(figuresFor({ hasRoute: true, hasElevation: true })).toEqual([
      'speed',
      'power',
      'togo',
      'arrive',
    ])
  })

  it('drops power on a track with no heights rather than showing a permanent dash', () => {
    const figures = figuresFor({ hasRoute: true, hasElevation: false })
    expect(figures).not.toContain('power')
    expect(figures).toContain('togo')
  })

  it('shows a bike computer with no route: how far, how long', () => {
    expect(figuresFor({ hasRoute: false, hasElevation: false })).toEqual([
      'speed',
      'ridden',
      'elapsed',
    ])
  })
})

describe('compactFigures', () => {
  it('keeps three, and keeps the two that answer “how much further”', () => {
    const compact = compactFigures(figuresFor({ hasRoute: true, hasElevation: true }))
    expect(compact).toEqual(['speed', 'togo', 'arrive'])
  })

  it('never drops below three, so the strip is not one lonely number', () => {
    // With no route there is nothing to drop: filtering out `ridden` would leave two.
    const compact = compactFigures(figuresFor({ hasRoute: false, hasElevation: false }))
    expect(compact).toHaveLength(3)
  })
})
