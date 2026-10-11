import { describe, expect, it } from 'vitest'
import { Meter, WINDOW_S, workloadMarkdown } from './workload'

/** `n` counts spread evenly across `[fromMs, toMs)`. */
function spread(meter: Meter, counter: 'frames' | 'fixes', n: number, fromMs: number, toMs: number) {
  for (let i = 0; i < n; i++) meter.count(counter, fromMs + ((toMs - fromMs) * i) / n)
}

describe('Meter', () => {
  it('reports a steady rate per minute over the window', () => {
    const meter = new Meter(0)
    // Sixty frames a second for two minutes: the window only ever holds the last sixty seconds.
    spread(meter, 'frames', 60 * 120, 0, 120_000)
    const snap = meter.snapshot(120_000)
    expect(snap.perMinute.frames).toBeCloseTo(3600, -1)
    expect(snap.totals.frames).toBe(7200)
  })

  // A ride ten seconds old is ten seconds of evidence. Dividing by the full window would report
  // a sixth of the real rate, which is exactly the number that makes a fix look like it worked.
  it('divides by the part of the window that has elapsed, not the whole of it', () => {
    const meter = new Meter(0)
    spread(meter, 'fixes', 10, 0, 10_000)
    expect(meter.snapshot(10_000).perMinute.fixes).toBeCloseTo(60, 0)
  })

  it('forgets what happened more than a window ago', () => {
    const meter = new Meter(0)
    spread(meter, 'frames', 600, 0, 10_000)
    const snap = meter.snapshot((WINDOW_S + 15) * 1000)
    expect(snap.perMinute.frames).toBe(0)
    // The total is the ride's, and does not forget.
    expect(snap.totals.frames).toBe(600)
  })

  it('zeroes only the seconds that went quiet, not the whole ring', () => {
    const meter = new Meter(0)
    spread(meter, 'frames', 30, 0, 30_000)
    // Twenty seconds of nothing, then one more.
    meter.count('frames', 50_500)
    const snap = meter.snapshot(59_500)
    // 31 counts in the window, which is the 59.5 seconds since the ride began.
    expect(snap.perMinute.frames).toBeCloseTo((31 / 59.5) * 60, 5)
  })

  it('starts a ride from zero and keeps what it cost once it ends', () => {
    const meter = new Meter(0)
    spread(meter, 'frames', 500, 0, 5_000)
    meter.startRide(10_000)
    expect(meter.snapshot(10_000).totals.frames).toBe(0)
    spread(meter, 'frames', 1200, 10_000, 130_000)
    meter.endRide(130_000)
    const snap = meter.snapshot(131_000)
    expect(snap.riding).toBe(false)
    expect(snap.lastRide?.durationS).toBe(120)
    expect(snap.lastRide?.totals.frames).toBe(1200)
    expect(snap.lastRide?.perMinute.frames).toBeCloseTo(600, 5)
  })

  it('ignores a second start or an end with no ride', () => {
    const meter = new Meter(0)
    meter.endRide(1000)
    expect(meter.snapshot(1000).lastRide).toBeNull()
    meter.startRide(1000)
    meter.count('fixes', 1500)
    meter.startRide(2000)
    expect(meter.snapshot(2000).totals.fixes).toBe(1)
  })
})

describe('workloadMarkdown', () => {
  it('names every counter in plain words, rounded', () => {
    const meter = new Meter(0)
    meter.startRide(0)
    spread(meter, 'frames', 100, 0, 30_000)
    const md = workloadMarkdown(meter.snapshot(30_000), { build: 'abc' })
    expect(md).toContain('- **build:** abc')
    expect(md).toContain('| map frames drawn | 200 | 100 |')
    expect(md).toContain('Riding, 30 s in.')
  })
})
