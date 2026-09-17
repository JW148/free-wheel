import { describe, expect, it } from 'vitest'
import { viewOnOpen } from './useRouteSheet'

const PLAN = { chosen: 'trekking', routes: { trekking: {}, fastbike: {} } }

describe('viewOnOpen', () => {
  /*
   * Minimising and reopening is not a decision about which view to show — it is the rider
   * putting the sheet down and picking it back up. Before this, a pull always re-derived the
   * view from the plan, so a rider comparing routes with one already ticked was thrown into
   * that route's detail every time they reopened the sheet they had just been reading.
   */
  it('gives back whichever view the sheet was last on', () => {
    expect(viewOnOpen('compare', PLAN)).toBe('compare')
    expect(viewOnOpen('detail', PLAN)).toBe('detail')
  })

  // The detail view describes the chosen route, so without one it has nothing to draw — and it
  // is reachable in that state, because clearing a choice does not close the sheet.
  it('falls back to the comparison when there is no chosen route to detail', () => {
    expect(viewOnOpen('detail', { chosen: null, routes: { trekking: {} } })).toBe('compare')
  })

  // A chosen profile whose route has gone: the plan was reversed, or a reroute is in flight.
  it('falls back when the chosen route is not one of the computed ones', () => {
    expect(viewOnOpen('detail', { chosen: 'shortest', routes: { trekking: {} } })).toBe('compare')
  })
})
