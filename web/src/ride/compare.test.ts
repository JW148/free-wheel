import { describe, expect, it } from 'vitest'
import { airDistanceM, COMPARE_CEILING_M, profilesToRun } from './useRoute'
import { DEFAULT_PROFILES } from './profiles'

/**
 * The distance guard.
 *
 * The second tap computes three routes instead of one, which triples a wait the rider did not
 * ask to lengthen. The guard is the only thing standing between that and a 120 km plan taking
 * three sequential BRouter searches on a phone, so it is tested at either side of its own
 * ceiling rather than trusted to a comment.
 */

const EDINBURGH = { lon: -3.19, lat: 55.95 }
/** ~20 km east: comfortably inside the ceiling. */
const NEARBY = { lon: -2.87, lat: 55.95 }
/** ~180 km south: comfortably outside it. */
const FAR = { lon: -3.19, lat: 54.35 }

describe('airDistanceM', () => {
  it('is zero for fewer than two points', () => {
    expect(airDistanceM([])).toBe(0)
    expect(airDistanceM([EDINBURGH])).toBe(0)
  })

  it('sums the legs rather than measuring end to end', () => {
    const viaDetour = airDistanceM([EDINBURGH, FAR, NEARBY])
    const direct = airDistanceM([EDINBURGH, NEARBY])
    expect(viaDetour).toBeGreaterThan(direct * 2)
  })
})

describe('profilesToRun', () => {
  it('runs all three on a short route, with the rider’s own style first', () => {
    const { run, deferred } = profilesToRun([...DEFAULT_PROFILES], 'gravel', 10_000)
    expect(run[0]).toBe('gravel')
    expect(run).toHaveLength(3)
    expect(deferred).toEqual([])
  })

  it('defers the other two past the ceiling', () => {
    const { run, deferred } = profilesToRun([...DEFAULT_PROFILES], 'fastbike', COMPARE_CEILING_M + 1)
    expect(run).toEqual(['fastbike'])
    expect(deferred).toEqual(['trekking', 'gravel'])
  })

  it('treats the ceiling itself as too far — the comparison is the thing being guarded', () => {
    expect(profilesToRun([...DEFAULT_PROFILES], 'trekking', COMPARE_CEILING_M).deferred).toHaveLength(2)
    expect(profilesToRun([...DEFAULT_PROFILES], 'trekking', COMPARE_CEILING_M - 1).deferred).toEqual([])
  })

  /*
   * A single-profile selection is not a comparison, so there is nothing to defer and the guard
   * must not fire. Deferring the only profile would leave a rider past the ceiling with no
   * route at all and no obvious way to ask for one.
   */
  it('never defers a lone profile, however long the route', () => {
    const { run, deferred } = profilesToRun(['gravel'], 'gravel', 500_000)
    expect(run).toEqual(['gravel'])
    expect(deferred).toEqual([])
  })

  /*
   * `preferred` comes from the rider's settings and the selection comes from the plan, so they
   * can disagree — a saved route collapses the selection to the profile it was computed with.
   * Ordering by a profile that is not being run would silently add it back.
   */
  it('ignores a preferred style that is not in the selection', () => {
    const { run } = profilesToRun(['trekking', 'gravel'], 'mtb', 10_000)
    expect(run).toEqual(['trekking', 'gravel'])
  })
})
