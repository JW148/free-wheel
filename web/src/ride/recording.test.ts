import { describe, expect, it } from 'vitest'
import {
  recordFix,
  startRecording,
  summarise,
  traceToGpx,
  worthKeeping,
  type RideRecord,
  type RideSample,
} from './recording'
import { haversineM } from './geo'

const START = Date.UTC(2026, 8, 8, 9, 0, 0)
const LAT = 55.95
const perDegreeE = haversineM([0, LAT], [1, LAT])

/** A fix `m` metres east of the origin, `s` seconds in. Everything else sensible by default. */
function fix(m: number, s: number, over: Partial<RideSample> = {}): RideSample {
  return {
    at: START + s * 1000,
    lon: m / perDegreeE,
    lat: LAT,
    accuracyM: 6,
    speedMps: 8,
    powerW: 200,
    routeElevM: 100,
    ...over,
  }
}

/** Rides `metres` at a steady `speed`, one fix a second, from a fresh record. */
function ride(metres: number, speedMps = 8, over: Partial<RideSample> = {}): RideRecord {
  let record = startRecording(START)
  for (let s = 0; s * speedMps <= metres; s++) {
    record = recordFix(record, fix(s * speedMps, s, { speedMps, ...over }))
  }
  return record
}

describe('recordFix', () => {
  it('accumulates distance, moving time and energy over a steady ride', () => {
    const record = ride(800)
    expect(record.distanceM).toBeCloseTo(800, 0)
    expect(record.movingS).toBeCloseTo(100, 0)
    // 200 W for 100 s is 20 kJ.
    expect(record.energyKj).toBeCloseTo(20, 0)
  })

  it('ignores a receiver wandering while the bike is stationary', () => {
    let record = startRecording(START)
    record = recordFix(record, fix(0, 0, { speedMps: 0 }))
    // Ten minutes at the lights, jittering by up to 4 m each second.
    for (let s = 1; s <= 600; s++) {
      record = recordFix(record, fix(Math.sin(s) * 4, s, { speedMps: 0, powerW: 0 }))
    }
    expect(record.distanceM).toBe(0)
    expect(record.movingS).toBe(0)
  })

  it('does not credit a teleport out of a tunnel as distance ridden', () => {
    let record = startRecording(START)
    record = recordFix(record, fix(0, 0))
    record = recordFix(record, fix(50, 5))
    const before = record.distanceM
    // 3 km in one second.
    record = recordFix(record, fix(3050, 6))
    expect(record.distanceM).toBe(before)
    // …but the next step is measured from where the rider now is, not from before the tunnel.
    record = recordFix(record, fix(3070, 7))
    expect(record.distanceM).toBeCloseTo(before + 20, 0)
  })

  it('counts a suspended app as elapsed time but not as moving time or energy', () => {
    let record = startRecording(START)
    record = recordFix(record, fix(0, 0))
    // iOS froze the app for twenty minutes; the next fix is a long way on.
    record = recordFix(record, fix(60, 1200))
    expect(summarise(record).elapsedS).toBeCloseTo(1200, 0)
    expect(record.movingS).toBeLessThanOrEqual(20)
    expect(record.energyKj).toBeLessThanOrEqual(4)
  })

  it('throws away a fix too vague to say anything', () => {
    let record = startRecording(START)
    record = recordFix(record, fix(0, 0))
    record = recordFix(record, fix(400, 1, { accuracyM: 900 }))
    expect(record.distanceM).toBe(0)
  })

  it('takes climbing from the route rather than from the fixes', () => {
    let record = startRecording(START)
    let elev = 100
    for (let s = 0; s <= 100; s++) {
      elev += 0.5
      record = recordFix(record, fix(s * 8, s, { routeElevM: elev }))
    }
    expect(record.ascentM).toBeCloseTo(50, 0)
  })

  it('does not count the way back up a descent it already came down', () => {
    // Down 60 m and back up 60 m is 60 m of climbing, not 120.
    let record = startRecording(START)
    for (let s = 0; s <= 60; s++) record = recordFix(record, fix(s * 8, s, { routeElevM: 200 - s }))
    for (let s = 61; s <= 120; s++) {
      record = recordFix(record, fix(s * 8, s, { routeElevM: 140 + (s - 60) }))
    }
    expect(record.ascentM).toBeCloseTo(60, 0)
  })

  it('stops accumulating climbing while off the route rather than guessing', () => {
    const record = ride(800, 8, { routeElevM: null })
    expect(record.ascentM).toBe(0)
    expect(record.distanceM).toBeCloseTo(800, 0)
  })

  it('remembers the fastest moment, but not an impossible one', () => {
    let record = startRecording(START)
    record = recordFix(record, fix(0, 0, { speedMps: 12 }))
    record = recordFix(record, fix(100, 1, { speedMps: 340 }))
    expect(record.maxSpeedMps).toBe(12)
  })

  it('thins the trace without dropping the ride', () => {
    const record = ride(2000, 8)
    expect(record.trace.length).toBeGreaterThan(50)
    expect(record.trace.length).toBeLessThanOrEqual(252)
    expect(record.trace[0].at).toBe(START)
  })

  it('leaves the previous record untouched, so React can see the change', () => {
    const before = startRecording(START)
    const after = recordFix(recordFix(before, fix(0, 0)), fix(80, 10))
    expect(before.distanceM).toBe(0)
    expect(before.trace).toHaveLength(0)
    expect(after.distanceM).toBeGreaterThan(0)
  })
})

describe('summarise', () => {
  it('averages speed over moving time, which is what a rider means by it', () => {
    let record = ride(800, 8)
    // Five minutes stopped at the end. The average must not fall.
    for (let s = 101; s <= 400; s++) {
      record = recordFix(record, fix(800, s, { speedMps: 0, powerW: 0 }))
    }
    const summary = summarise(record)
    expect(summary.avgSpeedMps).toBeCloseTo(8, 1)
    expect(summary.elapsedS).toBeGreaterThan(summary.movingS * 3)
  })

  it('time-weights average power rather than counting fixes', () => {
    let record = startRecording(START)
    // 100 W for one second, then 300 W for nine. Fix-weighted this would be 200.
    record = recordFix(record, fix(0, 0, { powerW: 100 }))
    record = recordFix(record, fix(8, 1, { powerW: 100 }))
    record = recordFix(record, fix(80, 10, { powerW: 300 }))
    expect(summarise(record).avgPowerW).toBeGreaterThan(250)
  })

  it('says nothing about power when nothing was ever estimated', () => {
    expect(summarise(ride(800, 8, { powerW: null })).avgPowerW).toBeNull()
  })

  it('divides nothing by zero on a ride that never started', () => {
    const summary = summarise(startRecording(START))
    expect(summary.avgSpeedMps).toBe(0)
    expect(summary.elapsedS).toBe(0)
    expect(summary.avgPowerW).toBeNull()
  })
})

describe('worthKeeping', () => {
  it('turns down a mis-tap on Start', () => {
    expect(worthKeeping(startRecording(START))).toBe(false)
    expect(worthKeeping(ride(80))).toBe(false)
  })

  it('keeps a real ride', () => {
    expect(worthKeeping(ride(2000))).toBe(true)
  })
})

describe('traceToGpx', () => {
  const gpx = traceToGpx(ride(500), 'Tuesday & the "long" way home')

  it('writes timestamps, which is what makes it a ride rather than a plan', () => {
    expect(gpx).toContain('<time>2026-09-08T09:00:00.000Z</time>')
    expect(gpx.match(/<trkpt/g)!.length).toBeGreaterThan(10)
  })

  it('escapes a name that would otherwise produce invalid XML', () => {
    expect(gpx).toContain('Tuesday &amp; the &quot;long&quot; way home')
    expect(gpx).not.toContain('the "long"')
  })

  it('round-trips through the app’s own GPX reader', async () => {
    const { parseBrouterGpx } = await import('./gpx')
    const parsed = parseBrouterGpx(gpx)
    expect(parsed.coords.length).toBeGreaterThan(10)
    expect(parsed.elevations.every((e) => e === 100)).toBe(true)
  })
})
