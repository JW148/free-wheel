import { describe, expect, it } from 'vitest'
import { archiveToOpen } from './archiveChoice'

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
