import { describe, expect, it } from 'vitest'
import {
  fold,
  loadIndex,
  mergeHits,
  nameAt,
  packIndex,
  searchIndex,
  type PlaceEntry,
} from './placeIndex'

const EDINBURGH = { lon: -3.19, lat: 55.95 }

/** Roughly where these actually are, so the distance ranking is answering a real question. */
const ENTRIES: PlaceEntry[] = [
  { name: 'Portobello', category: 'place', kind: 'neighbourhood', lon: -3.113, lat: 55.955 },
  { name: 'Portobello High Street', category: 'road', kind: 'minor_road', lon: -3.113, lat: 55.953 },
  { name: 'Portobello Beach', category: 'poi', kind: 'beach', lon: -3.108, lat: 55.958 },
  { name: 'Port Edgar Marina', category: 'poi', kind: 'marina', lon: -3.407, lat: 55.991 },
  { name: 'Portsburgh Square', category: 'place', kind: 'neighbourhood', lon: -3.196, lat: 55.946 },
  { name: 'High Street', category: 'road', kind: 'minor_road', lon: -3.188, lat: 55.95 },
  { name: 'High Street', category: 'road', kind: 'minor_road', lon: -2.72, lat: 55.95 },
  { name: 'Cramond Brig', category: 'poi', kind: 'attraction', lon: -3.303, lat: 55.968 },
  { name: "St Andrew's Square", category: 'place', kind: 'neighbourhood', lon: -3.192, lat: 55.955 },
  { name: 'Craigmillar', category: 'poi', kind: 'residential', lon: -3.14, lat: 55.93 },
  { name: 'Craigmillar', category: 'place', kind: 'neighbourhood', lon: -3.14, lat: 55.932 },
  { name: 'Water of Leith', category: 'water', kind: 'river', lon: -3.22, lat: 55.96 },
]

const loaded = loadIndex(packIndex('edinburgh.pmtiles', 1000, ENTRIES, 0))
const find = (query: string, near: { lon: number; lat: number } | null = EDINBURGH) =>
  searchIndex(loaded, query, near).map((hit) => `${hit.name} (${hit.category})`)

describe('fold', () => {
  it('drops case and accents, because nobody types either', () => {
    expect(fold('Bràigh')).toBe('braigh')
    expect(fold('PORTOBELLO')).toBe('portobello')
  })

  it('makes punctuation a word boundary, except the apostrophe', () => {
    expect(fold('Hay-on-Wye')).toBe('hay on wye')
    expect(fold("St Andrew's Square")).toBe('st andrews square')
    expect(fold('St. Ninians')).toBe('st ninians')
  })

  it('cannot produce the delimiter the haystack is built from', () => {
    expect(fold('a\nb')).toBe('a b')
  })
})

describe('packIndex and loadIndex', () => {
  it('round-trips every name', () => {
    expect(loaded.count).toBe(ENTRIES.length)
    ENTRIES.forEach((entry, i) => expect(nameAt(loaded, i)).toBe(entry.name))
  })

  it('keeps the coordinates inside what a GPS fix knows', () => {
    // Float32 over Britain is sub-metre, which is a tenth of the fix beside it.
    expect(loaded.source.lons[0]).toBeCloseTo(ENTRIES[0].lon, 5)
    expect(loaded.source.lats[0]).toBeCloseTo(ENTRIES[0].lat, 5)
  })

  it('survives an empty archive rather than indexing one empty name', () => {
    const empty = loadIndex(packIndex('nowhere.pmtiles', 0, [], 0))
    expect(empty.count).toBe(0)
    expect(searchIndex(empty, 'anything', null)).toEqual([])
  })
})

describe('searchIndex', () => {
  it('puts the exact name first', () => {
    expect(find('portobello')[0]).toBe('Portobello (place)')
  })

  it('finds every kind of thing a name can be attached to', () => {
    const hits = find('port')
    expect(hits).toContain('Portobello (place)')
    expect(hits).toContain('Portobello High Street (road)')
    expect(hits).toContain('Portobello Beach (poi)')
    expect(hits).toContain('Port Edgar Marina (poi)')
  })

  it('ranks a whole-word match above one buried mid-name', () => {
    // "burgh" starts a word in nothing here, so Portsburgh is the substring case; "beach"
    // starts one.
    const hits = find('beach')
    expect(hits[0]).toBe('Portobello Beach (poi)')
  })

  it('prefers the near one when two places share a name', () => {
    const near = searchIndex(loaded, 'High Street', EDINBURGH)
    expect(near[0].lon).toBeCloseTo(-3.188, 2)
    const east = searchIndex(loaded, 'High Street', { lon: -2.72, lat: 55.95 })
    expect(east[0].lon).toBeCloseTo(-2.72, 2)
  })

  it('prefers a settlement to a patch of housing with the same name', () => {
    expect(find('Craigmillar')[0]).toBe('Craigmillar (place)')
  })

  it('finds a name the rider typed without its punctuation', () => {
    expect(find('st andrews')[0]).toBe("St Andrew's Square (place)")
  })

  it('finds a word in the middle of a name', () => {
    expect(find('brig')).toContain('Cramond Brig (poi)')
  })

  it('says nothing rather than everything for an empty query', () => {
    expect(find('')).toEqual([])
    expect(find('   ')).toEqual([])
  })

  it('reports the distance when it was given somewhere to measure from, and null otherwise', () => {
    expect(searchIndex(loaded, 'Portobello', EDINBURGH)[0].distanceM).toBeGreaterThan(0)
    expect(searchIndex(loaded, 'Portobello', null)[0].distanceM).toBeNull()
  })

  it('never returns one name twice for matching twice inside itself', () => {
    const hits = searchIndex(loaded, 'o', EDINBURGH).map((h) => `${h.name}|${h.lon}`)
    expect(new Set(hits).size).toBe(hits.length)
  })
})

describe('mergeHits', () => {
  it('collapses the same place arriving from two overlapping regions', () => {
    // The published regions overlap generously, so a rider with both neighbours installed gets
    // Edinburgh from each of them.
    const central = searchIndex(loaded, 'Portobello', EDINBURGH)
    const southern = searchIndex(
      loadIndex(packIndex('southern-scotland.pmtiles', 1, ENTRIES, 0)),
      'Portobello',
      EDINBURGH,
    )
    const merged = mergeHits([central, southern])
    expect(merged.filter((hit) => hit.name === 'Portobello')).toHaveLength(1)
  })

  it('keeps two genuinely different places that share a name', () => {
    const merged = mergeHits([searchIndex(loaded, 'High Street', EDINBURGH)])
    expect(merged.filter((hit) => hit.name === 'High Street')).toHaveLength(2)
  })

  it('honours the limit', () => {
    expect(mergeHits([searchIndex(loaded, 'o', EDINBURGH)], 3)).toHaveLength(3)
  })
})
