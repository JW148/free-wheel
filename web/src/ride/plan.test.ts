import { describe, expect, it } from 'vitest'
import { chosenAfterRun, migratePlan, PLAN_VERSION } from './plan'

describe('migratePlan', () => {
  it('falls back to a single trekking selection when there is nothing stored', () => {
    expect(migratePlan(null)).toEqual({
      v: PLAN_VERSION,
      waypoints: [],
      selection: ['trekking'],
      chosen: null,
    })
  })

  it('rejects a plan whose shape is wrong rather than half-restoring it', () => {
    expect(migratePlan({ waypoints: 'nope', selection: ['gravel'] }).selection).toEqual(['trekking'])
    expect(migratePlan({ waypoints: [], selection: [] }).selection).toEqual(['trekking'])
  })

  it('keeps a current plan verbatim, including a deliberately empty choice', () => {
    const stored = {
      v: PLAN_VERSION,
      waypoints: [{ id: 'a', lon: -3.19, lat: 55.95 }],
      selection: ['trekking', 'gravel'],
      chosen: null,
      gpx: { trekking: '<gpx/>', gravel: '<gpx/>' },
    }
    expect(migratePlan(stored)).toEqual(stored)
  })

  it('keeps a current plan an explicit choice', () => {
    const stored = {
      v: PLAN_VERSION,
      waypoints: [],
      selection: ['trekking', 'gravel'],
      chosen: 'gravel',
      gpx: { trekking: '<gpx/>', gravel: '<gpx/>' },
    }
    expect(migratePlan(stored).chosen).toBe('gravel')
  })

  /*
   * v2 had no notion of choosing: `focused` was seeded with 'trekking' and could never be
   * empty, so a stored comparison carries a value that was a default rather than a decision.
   * Promoting it would silently pick a route for the rider — exactly the ambiguity this
   * change exists to remove.
   */
  it('drops a v2 comparison back to no choice', () => {
    const migrated = migratePlan({
      waypoints: [],
      selection: ['trekking', 'gravel'],
      focused: 'trekking',
      gpx: { trekking: '<gpx/>', gravel: '<gpx/>' },
    })
    expect(migrated.chosen).toBeNull()
    expect(migrated.v).toBe(PLAN_VERSION)
    expect(migrated.selection).toEqual(['trekking', 'gravel'])
  })

  it('promotes a v2 single route, where the focus was the only possible answer', () => {
    const migrated = migratePlan({
      waypoints: [],
      selection: ['gravel'],
      focused: 'gravel',
      gpx: { gravel: '<gpx/>' },
    })
    expect(migrated.chosen).toBe('gravel')
  })

  it('drops a v2 choice that no stored route backs', () => {
    expect(
      migratePlan({ waypoints: [], selection: ['gravel'], focused: 'gravel' }).chosen,
    ).toBeNull()
  })
})

describe('chosenAfterRun', () => {
  it('chooses the route when only one came back, comparison or not', () => {
    expect(chosenAfterRun(['gravel'])).toBe('gravel')
  })

  it('leaves the choice to the rider when several came back', () => {
    expect(chosenAfterRun(['trekking', 'gravel'])).toBeNull()
  })

  it('has nothing to choose when everything failed', () => {
    expect(chosenAfterRun([])).toBeNull()
  })
})
