import { describe, expect, it } from 'vitest'
import { archiveToOpen, handbackPlan } from './archiveChoice'

const installed = [{ name: 'wessex.pmtiles' }, { name: 'central-scotland.pmtiles' }]

describe('archiveToOpen', () => {
  it('honours the first preference that is actually installed', () => {
    expect(archiveToOpen(installed, ['central-scotland.pmtiles'])).toBe('central-scotland.pmtiles')
  })

  it('falls through preferences in order', () => {
    expect(archiveToOpen(installed, [null, 'wessex.pmtiles'])).toBe('wessex.pmtiles')
  })

  /*
   * The archive the picker displaced may have been deleted while it was up — Setup is
   * reachable from the picker, and deleting is one of the things it does.
   */
  it('skips a preference that is no longer installed rather than giving up', () => {
    expect(archiveToOpen(installed, ['deleted.pmtiles'])).toBe('wessex.pmtiles')
  })

  /*
   * The combination `endRemote` actually produces on a deleted displaced archive: the first
   * preference is gone and the second is installed but is *not* `installed[0]`. Test 3 above
   * cannot tell "carried on down the list" from "gave up and took the first", because there
   * the two answers coincide. Here they differ, so only one of them passes.
   */
  it('carries on down the list rather than giving up at the first miss', () => {
    expect(archiveToOpen(installed, ['deleted.pmtiles', 'central-scotland.pmtiles'])).toBe(
      'central-scotland.pmtiles',
    )
  })

  it('takes whatever is there when no preference survives', () => {
    expect(archiveToOpen(installed, [])).toBe('wessex.pmtiles')
  })

  /*
   * The "carry on without a region" exit on an empty phone. `null` rather than `undefined`
   * so the caller has to say what it does about it — the alternative left a streamed archive
   * on screen that looked like a working map and was not.
   */
  it('answers null when nothing is installed, which is a real answer', () => {
    expect(archiveToOpen([], ['wessex.pmtiles'])).toBeNull()
  })
})

describe('handbackPlan', () => {
  /*
   * The case this function exists for, and the one three rounds of fixes kept walking past.
   * `refresh()` answers `null` when the engine could not be asked at all — two Safari tabs
   * colliding over the same storage handles is the documented way in — and a handback that
   * returns early there leaves the loan open and a streamed backdrop on screen while telling
   * its caller it finished. There is nothing to restore *to*, so the only honest move is to
   * take the borrowed map down and say why.
   */
  it('takes the map down when storage could not be read at all', () => {
    expect(handbackPlan(null, ['wessex.pmtiles'])).toEqual({
      action: 'discard',
      outcome: 'unavailable',
    })
  })

  /*
   * Deliberately a different outcome from the one above, because they are different sentences
   * on screen: "you have no map yet" sends a rider to download one, "free-wheel cannot read
   * this phone" does not.
   */
  it('takes the map down when nothing is installed, which is a choice rather than a fault', () => {
    expect(handbackPlan([], ['wessex.pmtiles'])).toEqual({
      action: 'discard',
      outcome: 'nothing-installed',
    })
  })

  it('mounts the first preference that is installed', () => {
    expect(handbackPlan(installed, ['central-scotland.pmtiles'])).toEqual({
      action: 'mount',
      name: 'central-scotland.pmtiles',
    })
  })

  it('mounts whatever is there when no preference survives', () => {
    expect(handbackPlan(installed, ['deleted.pmtiles', null])).toEqual({
      action: 'mount',
      name: 'wessex.pmtiles',
    })
  })
})
