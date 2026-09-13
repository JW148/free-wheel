import { describe, expect, it } from 'vitest'
import { archiveToOpen, mountPlan } from './archiveChoice'

const installed = [{ name: 'wessex.pmtiles' }, { name: 'central-scotland.pmtiles' }]

describe('archiveToOpen', () => {
  it('honours the first preference that is actually installed', () => {
    expect(archiveToOpen(installed, ['central-scotland.pmtiles'])).toBe('central-scotland.pmtiles')
  })

  it('falls through preferences in order', () => {
    expect(archiveToOpen(installed, [null, 'wessex.pmtiles'])).toBe('wessex.pmtiles')
  })

  /*
   * The remembered archive may have been deleted since — removing a region is one of the
   * things the Maps screen does.
   */
  it('skips a preference that is no longer installed rather than giving up', () => {
    expect(archiveToOpen(installed, ['deleted.pmtiles'])).toBe('wessex.pmtiles')
  })

  /*
   * The first preference is gone and the second is installed but is *not* `installed[0]`. The
   * test above cannot tell "carried on down the list" from "gave up and took the first",
   * because there the two answers coincide. Here they differ, so only one of them passes.
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
   * The empty phone. `null` rather than `undefined` so the caller has to say what it does
   * about it — the alternative flowed an `undefined` on into a mount that quietly did nothing.
   */
  it('answers null when nothing is installed, which is a real answer', () => {
    expect(archiveToOpen([], ['wessex.pmtiles'])).toBeNull()
  })
})

describe('mountPlan', () => {
  it('takes the map down when nothing is installed', () => {
    expect(mountPlan([], [], ['wessex.pmtiles'])).toEqual({
      action: 'discard',
      outcome: 'nothing-installed',
    })
  })

  it('mounts every installed archive, not just the preferred one', () => {
    // The whole point of the change this replaced a handback for: a rider with two neighbouring
    // regions sees both, and the map does not go blank at the border between them.
    expect(mountPlan(installed, [], ['central-scotland.pmtiles'])).toEqual({
      action: 'mount',
      mount: ['wessex.pmtiles', 'central-scotland.pmtiles'],
      add: ['wessex.pmtiles', 'central-scotland.pmtiles'],
      remove: [],
      focus: 'central-scotland.pmtiles',
    })
  })

  it('adds only what is new, so a finished download does not remount the rest', () => {
    const plan = mountPlan(installed, ['wessex.pmtiles'], [])
    expect(plan).toMatchObject({ add: ['central-scotland.pmtiles'], remove: [] })
  })

  it('removes an archive that is drawn but no longer installed', () => {
    // A deleted region leaves a source MapLibre goes on requesting tiles from, and a missing
    // tile is reported as nothing at all — so it would look like a failed download for ever.
    const plan = mountPlan([{ name: 'wessex.pmtiles' }], ['wessex.pmtiles', 'gone.pmtiles'], [])
    expect(plan).toMatchObject({ add: [], remove: ['gone.pmtiles'] })
  })

  it('asks for no work at all when nothing has changed', () => {
    const names = installed.map((a) => a.name)
    expect(mountPlan(installed, names, [])).toMatchObject({ add: [], remove: [] })
  })

  it('focuses whatever is there when no preference survives', () => {
    expect(mountPlan(installed, [], ['deleted.pmtiles', null])).toMatchObject({
      focus: 'wessex.pmtiles',
    })
  })
})
