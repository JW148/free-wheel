import { describe, expect, it } from 'vitest'
import {
  chosenAfterRun,
  insertionIndex,
  isLoop,
  migratePlan,
  PLAN_VERSION,
  waypointRows,
  withEndpoint,
} from './plan'
import { DEFAULT_PROFILES } from './profiles'

describe('migratePlan', () => {
  it('falls back to the three offered styles when there is nothing stored', () => {
    expect(migratePlan(null)).toEqual({
      v: PLAN_VERSION,
      waypoints: [],
      selection: [...DEFAULT_PROFILES],
      chosen: null,
    })
  })

  it('rejects a plan whose shape is wrong rather than half-restoring it', () => {
    expect(migratePlan({ waypoints: 'nope', selection: ['gravel'] }).selection).toEqual([
      ...DEFAULT_PROFILES,
    ])
    expect(migratePlan({ waypoints: [], selection: [] }).selection).toEqual([...DEFAULT_PROFILES])
  })

  /*
   * The v3 → v4 upgrade, which is the redesign's one migration with a decision in it. A v3
   * selection was a tick-list, almost always left at one profile; a v4 selection is the three
   * cards the second tap computes. Widening it is right only where the selection was never
   * acted on — see the comment in `migratePlan`.
   */
  it('widens an unrouted v3 selection to the three offered styles', () => {
    const stored = { v: 3, waypoints: [{ id: 'a', lon: -3.19, lat: 55.95 }], selection: ['trekking'], chosen: null }
    expect(migratePlan(stored).selection).toEqual([...DEFAULT_PROFILES])
  })

  it('leaves a routed v3 selection alone, and keeps its route', () => {
    const stored = {
      v: 3,
      waypoints: [{ id: 'a', lon: -3.19, lat: 55.95 }],
      selection: ['gravel'],
      chosen: 'gravel',
      gpx: { gravel: '<gpx/>' },
    }
    const migrated = migratePlan(stored)
    expect(migrated.selection).toEqual(['gravel'])
    expect(migrated.chosen).toBe('gravel')
    expect(migrated.gpx).toEqual({ gravel: '<gpx/>' })
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

/**
 * A place chosen from the search has to land in the right slot whatever shape the plan was
 * already in — and the empty plan is the one that catches a naive implementation, where a
 * finish becomes the second of two points and the first is nowhere.
 */
describe('withEndpoint', () => {
  const p = (lon: number) => ({ lon, lat: 55.95 })
  const lons = (points: { lon: number }[]) => points.map((w) => w.lon)

  it('makes the first place chosen the only point, whichever slot it was chosen for', () => {
    expect(lons(withEndpoint([], 'start', p(1)))).toEqual([1])
    expect(lons(withEndpoint([], 'finish', p(1)))).toEqual([1])
  })

  it('replaces the start and keeps everything after it', () => {
    const plan = [...withEndpoint([], 'start', p(1)), ...withEndpoint([], 'finish', p(2))]
    expect(lons(withEndpoint(plan, 'start', p(9)))).toEqual([9, 2])
  })

  it('adds a finish to a lone start, then replaces it', () => {
    const one = withEndpoint([], 'start', p(1))
    const two = withEndpoint(one, 'finish', p(2))
    expect(lons(two)).toEqual([1, 2])
    expect(lons(withEndpoint(two, 'finish', p(3)))).toEqual([1, 3])
  })

  it('puts a stop before the finish, not after it', () => {
    const two = withEndpoint(withEndpoint([], 'start', p(1)), 'finish', p(3))
    expect(lons(withEndpoint(two, 'stop', p(2)))).toEqual([1, 2, 3])
  })

  it('drops the points a reroute added', () => {
    // They belong to the ride they were added during. Carrying one into a plan the rider has
    // just typed a new destination into would route them through last Tuesday's layby.
    const ridden = [
      { id: 'a', lon: 1, lat: 55.95 },
      { id: 'b', lon: 2, lat: 55.95, kind: 'reroute' as const },
      { id: 'c', lon: 3, lat: 55.95 },
    ]
    expect(lons(withEndpoint(ridden, 'finish', p(9)))).toEqual([1, 9])
  })

  it('gives every new point its own identity', () => {
    const one = withEndpoint([], 'start', p(1))
    expect(withEndpoint(one, 'start', p(1))[0].id).not.toBe(one[0].id)
  })
})

/*
 * Where a tapped point lands.
 *
 * The rule is one formula — the detour it would add — measured over the *waypoints* rather than
 * the drawn route, so it still answers when the route is stale, failed or absent. Every case
 * below is a shape the rider can put the plan into with two taps.
 */
describe('insertionIndex', () => {
  const at = (lon: number, lat: number) => ({ lon, lat })
  /** Points on one east-west line, so detours are readable as "out and back". */
  const A = at(-3.2, 55.95)
  const B = at(-3.1, 55.95)
  const C = at(-3.0, 55.95)

  it('appends when there is nothing to insert between', () => {
    expect(insertionIndex([], at(-3.2, 55.95))).toBe(0)
    expect(insertionIndex([A], at(-3.1, 55.95))).toBe(1)
  })

  it('extends the route when the tap is past the finish', () => {
    expect(insertionIndex([A, B], at(-3.0, 55.95))).toBe(2)
  })

  it('makes a via of a tap beside the line', () => {
    expect(insertionIndex([A, B], at(-3.15, 55.97))).toBe(1)
  })

  it('picks the leg the tap is actually beside', () => {
    expect(insertionIndex([A, B, C], at(-3.15, 55.97))).toBe(1)
    expect(insertionIndex([A, B, C], at(-3.05, 55.97))).toBe(2)
  })

  /*
   * Prepending is deliberately not a candidate. A tap behind the start becoming a *new start*
   * is surprising — the start is the one point the rider is surest about — and both the
   * search's start slot and dragging the start pin already move it properly. So a tap behind
   * the start becomes the first via, which is visible in the card and one × away.
   */
  it('never turns a tap behind the start into a new start', () => {
    expect(insertionIndex([A, B], at(-3.25, 55.95))).toBe(1)
  })

  /*
   * A closed loop is two coincident legs, so the detour cost is identical on both and the
   * rider's intent is genuinely ambiguous. The tie goes to the earlier leg, which puts the via
   * on the way out. Deterministic beats arbitrary: the alternative is the same tap landing
   * differently on two runs.
   */
  it('puts a via on the outbound leg of a loop, not the return', () => {
    expect(insertionIndex([A, C, A], at(-3.1, 55.97))).toBe(1)
  })
})

describe('waypointRows', () => {
  const w = (id: string, kind?: 'reroute') => ({
    id,
    lon: -3.2,
    lat: 55.95,
    ...(kind ? { kind } : {}),
  })

  it('names the two ends and numbers what is between them', () => {
    const rows = waypointRows([w('a'), w('b'), w('c'), w('d')])
    expect(rows.map((r) => r.badge)).toEqual(['S', '1', '2', 'F'])
    expect(rows.map((r) => r.word)).toEqual(['Start', 'Stop 1', 'Stop 2', 'Finish'])
  })

  it('leaves a lone start unnumbered as the start', () => {
    expect(waypointRows([w('a')]).map((r) => r.role)).toEqual(['start'])
  })

  /*
   * The numbering rule that matters mid-ride: a rejoin is a point the app added, so it is named
   * for what it is and does not shift the number of the stop after it. Renumbering the rider's
   * own pins because they took a wrong turn is the failure this prevents.
   */
  it('does not let a rejoin renumber the stops the rider placed', () => {
    const rows = waypointRows([w('a'), w('r', 'reroute'), w('b'), w('c')])
    expect(rows.map((r) => r.word)).toEqual(['Start', 'Rejoined', 'Stop 1', 'Finish'])
    expect(rows.map((r) => r.badge)).toEqual(['S', '', '1', 'F'])
  })

  it('treats a rejoin that ended up last as the finish, because it is one', () => {
    const rows = waypointRows([w('a'), w('r', 'reroute')])
    expect(rows.map((r) => r.role)).toEqual(['start', 'finish'])
  })
})

describe('isLoop', () => {
  const at = (lon: number, lat: number) => ({ lon, lat })

  it('is false for a journey between two places', () => {
    expect(isLoop([at(-3.2, 55.95), at(-3.1, 55.95)])).toBe(false)
  })

  it('is true once the finish is back on the start', () => {
    expect(isLoop([at(-3.2, 55.95), at(-3.1, 55.95), at(-3.2, 55.95)])).toBe(true)
  })

  /*
   * Generous on purpose. The ends coincide exactly when "Make a loop" put them there, but a
   * rider who dragged their finish back onto their own front door has described the same ride,
   * and offering to close a loop that is already closed is a button with nothing to do.
   */
  it('counts a finish dragged back to within a few metres as closed', () => {
    expect(isLoop([at(-3.2, 55.95), at(-3.1, 55.95), at(-3.2, 55.9502)])).toBe(true)
    expect(isLoop([at(-3.2, 55.95), at(-3.1, 55.95), at(-3.2, 55.955)])).toBe(false)
  })

  it('is false for a plan that is not yet a journey', () => {
    expect(isLoop([at(-3.2, 55.95)])).toBe(false)
    expect(isLoop([])).toBe(false)
  })
})
