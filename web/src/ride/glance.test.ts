import { describe, expect, it } from 'vitest'
import type { ParsedRoute } from './gpx'
import { haversineM } from './geo'
import { pointAt, routeGeometry } from './progress'
import {
  AHEAD_M,
  glanceCue,
  glanceLine,
  nearDistanceM,
  NEAR_MIN_M,
  rejoinAngle,
  svgPoints,
  toRiderFrame,
  travelBearing,
} from './glance'
import { turnLabel, type Turn } from './turns'

const LAT = 55.95
const perLon = haversineM([0, LAT], [1, LAT])
const perLat = haversineM([0, LAT], [0, LAT + 1])

/** 500 m east, then 500 m north: one left turn, at 500 m, with arithmetic answers. */
function lRoute(): ParsedRoute {
  const metres: [number, number][] = [
    [0, 0],
    [250, 0],
    [500, 0],
    [500, 250],
    [500, 500],
  ]
  return {
    coords: metres.map(([e, n]) => [e / perLon, LAT + n / perLat] as [number, number]),
    elevations: metres.map(() => 0),
    distanceM: 1000,
    ascendM: 0,
    timeS: null,
    name: 'L',
  }
}

const geometry = routeGeometry(lRoute())!
const left: Turn = { atM: 500, kind: 'left', exit: null }
const right: Turn = { atM: 560, kind: 'right', exit: null }

const near = (a: number, b: number, within = 2) => Math.abs(a - b) <= within

describe('toRiderFrame', () => {
  const origin = geometry.coords[0]
  const east = pointAt(geometry, 100)

  it('puts a point due east straight ahead when facing east', () => {
    const [x, y] = toRiderFrame(origin, 90, east)
    expect(near(x, 0)).toBe(true)
    expect(near(y, 100)).toBe(true)
  })

  it('puts it on the right when facing north', () => {
    const [x, y] = toRiderFrame(origin, 0, east)
    expect(near(x, 100)).toBe(true)
    expect(near(y, 0)).toBe(true)
  })
})

describe('travelBearing', () => {
  it('reads east along the first leg', () => {
    expect(near(travelBearing(geometry, 300), 90, 1)).toBe(true)
  })

  // The whole reason it looks behind: approaching the corner, the view must not have turned.
  it('has not turned 10 m before the corner', () => {
    expect(near(travelBearing(geometry, 490), 90, 1)).toBe(true)
  })

  it('has turned once the corner is behind by the lookback', () => {
    expect(near(travelBearing(geometry, 540), 0, 1)).toBe(true)
  })

  it('looks ahead at the very start, where there is nothing behind', () => {
    expect(near(travelBearing(geometry, 0), 90, 1)).toBe(true)
  })
})

describe('glanceLine', () => {
  const at = (alongM: number) => pointAt(geometry, alongM)

  it('draws the road ahead straight up and the turn at its distance', () => {
    const line = glanceLine({
      geometry,
      alongM: 320,
      snapped: at(320),
      fix: at(320),
      offRoute: false,
      bearing: 90,
      turn: left,
    })
    const [x0, y0] = line.ahead[0]
    expect(near(x0, 0) && near(y0, 0)).toBe(true)
    expect(line.turn).not.toBeNull()
    expect(near(line.turn!.at[0], 0)).toBe(true)
    expect(near(line.turn!.at[1], 180)).toBe(true)
    // After the corner the line goes to the rider's left.
    const last = line.ahead[line.ahead.length - 1]
    expect(last[0]).toBeLessThan(-100)
  })

  it('stops at the window and leaves out a turn beyond it', () => {
    const line = glanceLine({
      geometry,
      alongM: 0,
      snapped: at(0),
      fix: at(0),
      offRoute: false,
      bearing: 90,
      turn: left,
    })
    expect(line.turn).toBeNull()
    const last = line.ahead[line.ahead.length - 1]
    expect(near(last[1], AHEAD_M)).toBe(true)
  })

  it('draws the faint stretch behind the rider', () => {
    const line = glanceLine({
      geometry,
      alongM: 300,
      snapped: at(300),
      fix: at(300),
      offRoute: false,
      bearing: 90,
      turn: null,
    })
    expect(near(line.ridden[0][1], -60)).toBe(true)
  })

  it('off route, centres on the fix and points at the route', () => {
    // 80 m south of the first leg, at 300 m along.
    const snapped = at(300)
    const fix: [number, number] = [snapped[0], snapped[1] - 80 / perLat]
    const line = glanceLine({
      geometry,
      alongM: 300,
      snapped,
      fix,
      offRoute: true,
      bearing: 90,
      turn: left,
    })
    expect(line.ridden).toEqual([])
    expect(line.turn).toBeNull()
    // Facing east, north is on the left.
    expect(near(line.rejoin![0], -80)).toBe(true)
    expect(near(rejoinAngle(line.rejoin), -90, 1)).toBe(true)
  })
})

describe('glanceCue', () => {
  const base = {
    tracking: true,
    offRoute: false,
    offsetM: 3,
    turns: [left, right],
    remainingM: 700,
    speedMps: 6,
    label: turnLabel,
  }

  it('waits before the first fix', () => {
    expect(glanceCue({ ...base, tracking: false, turnAhead: null }).tone).toBe('waiting')
  })

  it('says keep going, dimmed, far from the turn', () => {
    const cue = glanceCue({ ...base, turnAhead: { turn: left, awayM: 1800 } })
    expect(cue).toMatchObject({ tone: 'far', glyph: 'straight', distanceM: 1800, words: 'then left' })
  })

  it('draws the turn and the one chained behind it when near', () => {
    const cue = glanceCue({ ...base, turnAhead: { turn: left, awayM: 150 } })
    expect(cue).toMatchObject({ tone: 'near', glyph: 'left', words: 'Left' })
    expect(cue.then).toBe(right)
  })

  it('names the exit at a roundabout', () => {
    const roundabout: Turn = { atM: 500, kind: 'roundabout', exit: 3 }
    const cue = glanceCue({ ...base, turns: [roundabout], turnAhead: { turn: roundabout, awayM: 90 } })
    expect(cue.words).toBe('3rd exit')
  })

  it('counts down to the finish when no turns are left', () => {
    const cue = glanceCue({ ...base, turns: [], turnAhead: null, remainingM: 3000 })
    expect(cue).toMatchObject({ tone: 'far', glyph: 'end', distanceM: 3000, words: 'Finish' })
  })

  it('beats every other state when off route', () => {
    const cue = glanceCue({ ...base, offRoute: true, offsetM: 60, turnAhead: { turn: left, awayM: 50 } })
    expect(cue).toMatchObject({ tone: 'off', distanceM: 60, words: 'Off route' })
  })
})

describe('nearDistanceM', () => {
  it('is thirty seconds at riding speed and floored when slow', () => {
    expect(nearDistanceM(6)).toBe(180)
    expect(nearDistanceM(1)).toBe(NEAR_MIN_M)
    expect(nearDistanceM(null)).toBeGreaterThanOrEqual(NEAR_MIN_M)
  })
})

describe('svgPoints', () => {
  it('flips y so ahead is up the screen', () => {
    expect(svgPoints([[0, 0], [10, 20]], 2, [100, 300])).toBe('100.0,300.0 120.0,260.0')
  })
})
