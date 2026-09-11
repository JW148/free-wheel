import { describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion } from '../data/manifest'
import { recordAfterDownload, recordsAfterRemoval } from './regionStore'

const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
  },
  regions: [
    { id: 'wessex', name: 'Wessex and the South Coast', bbox: [-2.6, 50.5, -0.7, 51.6],
      basemap: { url: 'regions/wessex-1111aaaa.pmtiles', bytes: 90000000, hash: '1111aaaa', built: '2026-09-08' },
      segments: ['W5_N50'] },
    { id: 'south-west-england', name: 'South West England', bbox: [-5.8, 49.9, -2.4, 51.5],
      basemap: { url: 'regions/south-west-england-2222bbbb.pmtiles', bytes: 70000000, hash: '2222bbbb', built: '2026-09-08' },
      segments: ['W5_N50'] },
  ],
}

const wessex: InstalledRegion = {
  id: 'wessex', basemapHash: '1111aaaa', segmentHashes: { W5_N50: 'bbbb2222' }, installedAt: 1,
}

describe('recordAfterDownload', () => {
  it('adds a region with the hashes it was downloaded at', () => {
    const records = recordAfterDownload([], manifest.regions[0], manifest, 1)
    expect(records).toEqual([wessex])
  })

  it('replaces an earlier record for the same region rather than duplicating it', () => {
    const stale = { ...wessex, basemapHash: 'old', installedAt: 0 }
    const records = recordAfterDownload([stale], manifest.regions[0], manifest, 2)
    expect(records).toHaveLength(1)
    expect(records[0].basemapHash).toBe('1111aaaa')
    expect(records[0].installedAt).toBe(2)
  })
})

describe('recordsAfterRemoval', () => {
  it('deletes the segment when no other region needs it', () => {
    const result = recordsAfterRemoval([wessex], 'wessex')
    expect(result.records).toEqual([])
    expect(result.deleteSegments).toEqual(['W5_N50'])
    expect(result.deleteBasemap).toBe('wessex.pmtiles')
  })

  it('keeps a shared segment that another installed region still routes on', () => {
    const southWest = recordAfterDownload([wessex], manifest.regions[1], manifest, 3)
    const result = recordsAfterRemoval(southWest, 'wessex')
    expect(result.records.map((r) => r.id)).toEqual(['south-west-england'])
    expect(result.deleteSegments).toEqual([])
  })

  it('is a no-op for a region that is not installed', () => {
    const result = recordsAfterRemoval([wessex], 'kent-sussex')
    expect(result.records).toEqual([wessex])
    expect(result.deleteSegments).toEqual([])
  })
})
