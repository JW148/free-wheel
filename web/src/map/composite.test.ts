import { describe, expect, it } from 'vitest'
import { insertionPoint } from './composite'
import { basemapRoles, basemapStyle, layerArchive, layerRole, sourceIdFor } from './style'

// `basemapStyle` resolves its glyph and sprite URLs against the document origin; under Node
// there is no `location`. Same stub, and same reason, as `style.test.ts`.
Object.defineProperty(globalThis, 'location', {
  value: new URL('http://localhost:4174/'),
  configurable: true,
})

const ROLES = basemapRoles()
const ids = (archives: string[]) => basemapStyle(archives).layers.map((layer) => layer.id)

describe('basemapStyle over several archives', () => {
  it('gives every archive its own source', () => {
    const style = basemapStyle(['a.pmtiles', 'b.pmtiles'])
    expect(Object.keys(style.sources).sort()).toEqual(
      [sourceIdFor('a.pmtiles'), sourceIdFor('b.pmtiles')].sort(),
    )
  })

  it('orders by role, not by archive', () => {
    // The failure this guards is visible rather than theoretical: grouped by archive, the
    // second region's land fills paint over the first region's roads everywhere the two
    // overlap, which the published regions do by design.
    const roles = ids(['a.pmtiles', 'b.pmtiles']).map(layerRole)
    for (let i = 1; i < roles.length; i += 1) {
      expect(ROLES.indexOf(roles[i]), `${roles[i - 1]} then ${roles[i]}`).toBeGreaterThanOrEqual(
        ROLES.indexOf(roles[i - 1]),
      )
    }
  })

  it('draws each archive once per role', () => {
    const two = ids(['a.pmtiles', 'b.pmtiles'])
    const one = ids(['a.pmtiles'])
    expect(two.length).toBe(one.length * 2 - 1) // background is shared
    expect(two.filter((id) => layerArchive(id) === 'a.pmtiles')).toHaveLength(one.length - 1)
  })

  it('answers a background-only style for no archives at all', () => {
    const style = basemapStyle([])
    expect(style.layers.map((l) => l.id)).toEqual(['background'])
    expect(style.sources).toEqual({})
  })

  it('keeps single-archive output identical whether given a string or a list', () => {
    expect(basemapStyle('a.pmtiles')).toEqual(basemapStyle(['a.pmtiles']))
  })
})

describe('insertionPoint', () => {
  const existing = ids(['a.pmtiles'])

  it('puts a role before the first layer that outranks it', () => {
    const before = insertionPoint(existing, 'water', ROLES)
    expect(before).toBeDefined()
    expect(ROLES.indexOf(layerRole(before!))).toBeGreaterThan(ROLES.indexOf('water'))
  })

  it('never inserts before background', () => {
    for (const role of ROLES.slice(1)) {
      expect(insertionPoint(existing, role, ROLES)).not.toBe('background')
    }
  })

  it('appends the last role when nothing outranks it', () => {
    expect(insertionPoint(existing, ROLES[ROLES.length - 1], ROLES)).toBeUndefined()
  })

  it('goes in above the basemap but below the route line', () => {
    // The route and position layers are added on top and carry no archive, so they rank last.
    // A new archive's final role must land before them rather than over them — a region
    // downloaded mid-ride must not bury the line the rider is following.
    const withRoute = [...existing, 'route-travelled', 'position-dot']
    expect(insertionPoint(withRoute, ROLES[ROLES.length - 1], ROLES)).toBe('route-travelled')
  })

  it('answers undefined for a role it does not know', () => {
    expect(insertionPoint(existing, 'not-a-role', ROLES)).toBeUndefined()
  })

  it('reproduces the full order when an archive is spliced in one role at a time', () => {
    // The property that matters: splicing archive B into a live map holding archive A must
    // give the same layer order as building the style with both from scratch.
    const live = [...ids(['a.pmtiles'])]
    for (const layer of basemapStyle(['b.pmtiles']).layers.slice(1)) {
      const at = insertionPoint(live, layerRole(layer.id), ROLES)
      const index = at === undefined ? live.length : live.indexOf(at)
      live.splice(index, 0, layer.id)
    }
    expect(live.map(layerRole)).toEqual(ids(['a.pmtiles', 'b.pmtiles']).map(layerRole))
  })
})
