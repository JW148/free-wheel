import { describe, expect, it } from 'vitest'
import {
  ARROW_MIN_INTERVAL_MS,
  cameraStep,
  chooseHeading,
  outsideFollowBox,
  shouldPublishCompass,
} from './camera'

const VIEW = { width: 390, height: 844 }
const MIDDLE = { x: 195, y: 422 }

/** A riding fix, course-up off, dot in the middle, nothing forced: the common case. */
const riding = {
  following: true,
  paused: false,
  courseUp: false,
  heading: 90,
  bearingNow: 0,
  dot: MIDDLE,
  viewport: VIEW,
  force: false,
}

describe('chooseHeading', () => {
  it('takes the GPS course while moving, however the compass reads', () => {
    expect(chooseHeading({ compass: 40, course: 90, speedMps: 5.5 })).toEqual({
      heading: 90,
      source: 'course',
    })
  })

  // The reason the compass exists at all: iOS reports no course below a few km/h, which is
  // every junction and every set of lights.
  it('takes the compass when slow or stopped', () => {
    expect(chooseHeading({ compass: 40, course: 90, speedMps: 0.4 }).source).toBe('compass')
    expect(chooseHeading({ compass: 40, course: null, speedMps: 6 }).heading).toBe(40)
  })

  it('falls back to whichever there is', () => {
    expect(chooseHeading({ compass: null, course: 90, speedMps: 0 }).heading).toBe(90)
    expect(chooseHeading({ compass: null, course: 90, speedMps: null }).heading).toBe(90)
    expect(chooseHeading({ compass: null, course: null, speedMps: 5 })).toEqual({
      heading: null,
      source: null,
    })
  })
})

describe('shouldPublishCompass', () => {
  it('always shows the first reading', () => {
    expect(shouldPublishCompass({ shown: null, shownAtMs: null, next: 10, nowMs: 0 })).toBe(true)
  })

  it('ignores jitter inside the deadband, however long it has been', () => {
    expect(shouldPublishCompass({ shown: 10, shownAtMs: 0, next: 16, nowMs: 10_000 })).toBe(false)
  })

  it('waits out the interval, however far the compass swung', () => {
    expect(
      shouldPublishCompass({ shown: 10, shownAtMs: 0, next: 90, nowMs: ARROW_MIN_INTERVAL_MS - 1 }),
    ).toBe(false)
    expect(
      shouldPublishCompass({ shown: 10, shownAtMs: 0, next: 90, nowMs: ARROW_MIN_INTERVAL_MS }),
    ).toBe(true)
  })

  it('measures the gap round the circle, not across it', () => {
    expect(shouldPublishCompass({ shown: 356, shownAtMs: 0, next: 2, nowMs: 5000 })).toBe(false)
  })
})

describe('outsideFollowBox', () => {
  it('keeps a dot near the middle inside', () => {
    expect(outsideFollowBox(MIDDLE, VIEW)).toBe(false)
    expect(outsideFollowBox({ x: 195 + 50, y: 422 - 100 }, VIEW)).toBe(false)
  })

  it('lets it out past the edge of the box on either axis', () => {
    expect(outsideFollowBox({ x: 195 + 70, y: 422 }, VIEW)).toBe(true)
    expect(outsideFollowBox({ x: 195, y: 422 + 140 }, VIEW)).toBe(true)
  })
})

describe('cameraStep', () => {
  it('leaves the camera alone while the dot is inside the box', () => {
    expect(cameraStep(riding)).toBeNull()
  })

  it('recentres once the dot leaves the box', () => {
    expect(cameraStep({ ...riding, dot: { x: 300, y: 422 } })).toEqual({
      centre: true,
      bearing: null,
    })
  })

  // The bug this module exists for: a compass reading changes many times a second on a bike,
  // and with course-up off it has nothing whatever to say to the camera.
  it('never moves for the heading with course-up off', () => {
    for (const heading of [0, 45, 90, 181, 300]) {
      expect(cameraStep({ ...riding, heading })).toBeNull()
    }
  })

  it('turns course-up only past the deadband', () => {
    const up = { ...riding, courseUp: true, bearingNow: 90 }
    expect(cameraStep({ ...up, heading: 98 })).toBeNull()
    expect(cameraStep({ ...up, heading: 130 })).toEqual({ centre: false, bearing: 130 })
  })

  // Recentring and rotating in one move, or the second cancels the first. See CLAUDE.md.
  it('recentres and turns in the same move when both are due', () => {
    expect(
      cameraStep({ ...riding, courseUp: true, bearingNow: 0, heading: 90, dot: { x: 10, y: 10 } }),
    ).toEqual({ centre: true, bearing: 90 })
  })

  it('does both at once when forced, box and deadband regardless', () => {
    expect(
      cameraStep({ ...riding, courseUp: true, bearingNow: 88, heading: 90, force: true }),
    ).toEqual({ centre: true, bearing: 90 })
    expect(cameraStep({ ...riding, force: true })).toEqual({ centre: true, bearing: null })
  })

  it('goes back to north when course-up is turned off, or the ride ends', () => {
    expect(cameraStep({ ...riding, bearingNow: 140 })).toEqual({ centre: false, bearing: 0 })
    expect(cameraStep({ ...riding, following: false, courseUp: true, bearingNow: 140 })).toEqual({
      centre: false,
      bearing: 0,
    })
  })

  // Panning to look up the road must not spin the map under the rider's thumb.
  it('neither follows nor turns while paused by a pan', () => {
    expect(
      cameraStep({ ...riding, paused: true, courseUp: true, bearingNow: 140, dot: { x: 0, y: 0 } }),
    ).toBeNull()
  })

  it('does nothing without a fix or a heading to act on', () => {
    expect(cameraStep({ ...riding, dot: null, courseUp: true, heading: null, force: true })).toBeNull()
  })
})
