import { describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion } from '../data/manifest'
import { summarise } from './pickerModel'
import {
  freedBy,
  regionsAt,
  removalPrice,
  storageLine,
  storageTotal,
  updatable,
  withNearestFirst,
} from './libraryModel'

/**
 * Two neighbouring regions that share one of their two segments — the case the whole storage
 * model turns on. `W5_N50` is shared; `W5_N55` belongs to the north only.
 */
const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-01T00:00:00Z',
  picker: { url: 'picker.pmtiles', bytes: 1 },
  segments: {
    W5_N50: { url: 'W5_N50.rd5', bytes: 137_000_000, hash: 'south', built: '' },
    W5_N55: { url: 'W5_N55.rd5', bytes: 90_000_000, hash: 'north', built: '' },
  },
  regions: [
    {
      id: 'north',
      name: 'North',
      bbox: [-3, 54, -1, 56],
      basemap: { url: 'north.pmtiles', bytes: 40_000_000, hash: 'nb', built: '' },
      segments: ['W5_N50', 'W5_N55'],
    },
    {
      id: 'south',
      name: 'South',
      bbox: [-2, 50, 0, 55],
      basemap: { url: 'south.pmtiles', bytes: 30_000_000, hash: 'sb', built: '' },
      segments: ['W5_N50'],
    },
  ],
} as unknown as DataManifest

const record = (id: string, segments: Record<string, string>, at = 0): InstalledRegion => ({
  id,
  basemapHash: id === 'north' ? 'nb' : 'sb',
  segmentHashes: segments,
  installedAt: at,
})

const north = record('north', { W5_N50: 'south', W5_N55: 'north' })
const south = record('south', { W5_N50: 'south' })

describe('storageTotal', () => {
  it('counts a shared segment once', () => {
    // Added up naively this is 297 MB. On the disk it is 297 - 137 = 160 MB, and the phone's
    // own storage settings will say so — a library that disagrees with them is not believed.
    expect(storageTotal(manifest, [north, south])).toBe(40_000_000 + 30_000_000 + 227_000_000)
  })

  it('is zero on an empty phone', () => {
    expect(storageTotal(manifest, [])).toBe(0)
  })
})

describe('freedBy', () => {
  it('keeps road data another region still needs', () => {
    // Removing South frees its 30 MB map and nothing else: the 137 MB segment is North's too.
    expect(freedBy(manifest, [north, south], 'south')).toBe(30_000_000)
  })

  it('frees the road data once nothing else wants it', () => {
    expect(freedBy(manifest, [south], 'south')).toBe(30_000_000 + 137_000_000)
  })

  it('frees a region’s exclusive segments even while it shares others', () => {
    expect(freedBy(manifest, [north, south], 'north')).toBe(40_000_000 + 90_000_000)
  })

  it('answers zero for a region that is not installed', () => {
    expect(freedBy(manifest, [south], 'north')).toBe(0)
  })
})

describe('removalPrice', () => {
  it('names the consequence as well as the number', () => {
    // The number is the easy half. What a rider has not thought about is that this is where
    // routing stops working, not just where the map goes grey.
    expect(removalPrice(30_000_000)).toContain('Frees 30 MB')
    expect(removalPrice(30_000_000)).toContain('plan or follow routes')
  })

  it('still states the consequence when nothing is freed', () => {
    expect(removalPrice(0)).not.toContain('Frees')
    expect(removalPrice(0)).toContain('plan or follow routes')
  })
})

describe('regionsAt', () => {
  it('answers every region a point falls in, because the boxes overlap', () => {
    expect(regionsAt(manifest.regions, -2, 54.5).sort()).toEqual(['north', 'south'])
  })

  it('answers nothing out at sea', () => {
    expect(regionsAt(manifest.regions, 10, 60)).toEqual([])
  })
})

describe('withNearestFirst', () => {
  const summaries = summarise(manifest, [], true)

  it('leaves the order alone when there is no fix', () => {
    expect(withNearestFirst(summaries, []).map((s) => s.id)).toEqual(['north', 'south'])
  })

  it('lifts the regions you are standing in, keeping the rest as they were', () => {
    expect(withNearestFirst(summaries, ['south']).map((s) => s.id)).toEqual(['south', 'north'])
  })
})

describe('updatable', () => {
  it('offers an update where there is something to fetch', () => {
    const stale = { ...north, basemapHash: 'last-month' }
    expect(updatable(summarise(manifest, [stale, south], true)).map((s) => s.id)).toEqual(['north'])
  })

  it('does not offer an update a neighbour has already paid for', () => {
    // North's copy of the shared segment is stale, so `regionState` calls it outdated — but
    // South has already fetched the current bytes into the same file, so the plan costs
    // nothing. "Update (0 MB)" reads as broken.
    const stale = record('north', { W5_N50: 'old', W5_N55: 'north' })
    expect(updatable(summarise(manifest, [stale, south], true))).toEqual([])
  })

  it('does not count a region that has never been downloaded', () => {
    expect(updatable(summarise(manifest, [], true))).toEqual([])
  })
})

describe('storageLine', () => {
  it('explains why the total is less than the sizes added up', () => {
    expect(storageLine(2, 197_000_000)).toContain('share their road data')
  })

  it('says nothing clever about an empty phone', () => {
    expect(storageLine(0, 0)).toBe('Nothing downloaded yet.')
  })
})
