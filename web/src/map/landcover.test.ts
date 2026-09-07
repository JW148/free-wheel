import { describe, expect, it } from 'vitest'
import { LANDCOVER_KINDS, LAND_TIERS, type LandClass, classify } from './landcover'

/**
 * Every `kind` the `landuse` source-layer actually produces, harvested by decoding 150 tiles
 * from `data/basemap/edinburgh.pmtiles` across z3-z15 — not from the schema documentation.
 *
 * There are 43 of them. The first pass at this design assumed 28 and quietly missed `other`,
 * `platform`, `dog_park`, `pier`, `zoo`, `dam`, `village_green`, `national_park` and `glacier`.
 * An unclassified kind is not a crash, it is a polygon painted the fallback colour — which is
 * exactly the kind of silent wrongness this repo keeps getting bitten by, so it gets a test.
 */
const LANDUSE_KINDS = [
  'aerodrome', 'airfield', 'allotments', 'bare_rock', 'beach', 'cemetery', 'college',
  'commercial', 'dam', 'dog_park', 'farmland', 'forest', 'garden', 'glacier', 'golf_course',
  'grass', 'grassland', 'hospital', 'industrial', 'kindergarten', 'meadow', 'military',
  'national_park', 'nature_reserve', 'other', 'park', 'pedestrian', 'pier', 'pitch',
  'platform', 'playground', 'railway', 'recreation_ground', 'residential', 'runway', 'sand',
  'school', 'scrub', 'university', 'village_green', 'wetland', 'wood', 'zoo',
]

/**
 * The `landcover` source-layer's kinds. It is a different layer with a much coarser
 * vocabulary, and it is live only at **z3-z7** — from z7 upward `landuse` takes over and
 * `landcover` returns nothing at all. Worth rendering anyway: `urban_area` is the only
 * built-up signal that exists at continent zoom.
 */
const LANDCOVER_KINDS_IN_ARCHIVE = ['barren', 'farmland', 'forest', 'glacier', 'grassland', 'urban_area']

describe('classify', () => {
  it('classifies every landuse kind present in the archive', () => {
    const unclassified = LANDUSE_KINDS.filter((kind) => classify(kind) === undefined)
    expect(unclassified).toEqual([])
  })

  it('classifies every landcover kind present in the archive', () => {
    const unclassified = LANDCOVER_KINDS_IN_ARCHIVE.filter((kind) => classify(kind) === undefined)
    expect(unclassified).toEqual([])
  })

  it('returns undefined for a kind a future schema version might add', () => {
    // The style falls back to a neutral for these rather than dropping them, but the mapping
    // itself must admit it does not know — otherwise this test could never detect drift.
    expect(classify('hyperloop_terminal')).toBeUndefined()
  })

  it('keeps private gardens out of the park class', () => {
    // `garden` is the most common kind in the archive by a wide margin — 1,914 polygons in one
    // 2x2 block at z13 against 64 actual parks, median size 17px². Painting them as parkland
    // makes tenement streets read as green space and dilutes the one colour that should mean
    // "open space you can actually use".
    expect(classify('garden')).toBe('garden')
    expect(classify('park')).toBe('park')
  })

  it('treats forestry and woodland as one class', () => {
    expect(classify('wood')).toBe('wood')
    expect(classify('forest')).toBe('wood')
  })

  it('maps the landcover layer onto the same classes as landuse', () => {
    // Reusing the classes means the low-zoom view and the street view agree on what green
    // means, rather than being two unrelated palettes that meet at z7.
    expect(classify('urban_area')).toBe('residential')
    expect(classify('barren')).toBe('bare')
    expect(classify('grassland')).toBe('grass')
  })
})

describe('LANDCOVER_KINDS', () => {
  it('matches the vocabulary the archive actually produces', () => {
    // If Protomaps widens the `landcover` vocabulary, the low-zoom layers silently stop
    // drawing the new kind. This is what turns that into a test failure.
    expect([...LANDCOVER_KINDS].sort()).toEqual([...LANDCOVER_KINDS_IN_ARCHIVE].sort())
  })
})

describe('LAND_TIERS', () => {
  it('assigns every class to exactly one tier', () => {
    // Protomaps stamps `sort_rank` 189 on *every* landuse feature, so the tile carries no
    // ordering information at all. Draw order therefore has to come from the layer list, and
    // a class in two tiers would be painted twice for no reason while a class in none would
    // vanish.
    const seen = LAND_TIERS.flatMap((tier) => tier.classes)
    expect(new Set(seen).size, 'a class appears in more than one tier').toBe(seen.length)
  })

  it('draws parks above general greenery, greenery above gardens, and all of it above the built-up base', () => {
    const tierOf = (cls: LandClass): number =>
      LAND_TIERS.findIndex((tier) => tier.classes.includes(cls))

    expect(tierOf('park')).toBeGreaterThan(tierOf('wood'))
    expect(tierOf('wood')).toBeGreaterThan(tierOf('garden'))
    expect(tierOf('garden')).toBeGreaterThan(tierOf('farm'))
    expect(tierOf('farm')).toBeGreaterThan(tierOf('residential'))
  })

  it('gives every tier a stable id', () => {
    const ids = LAND_TIERS.map((tier) => tier.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^land-/)
  })
})
