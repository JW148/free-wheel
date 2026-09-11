import { describe, expect, it } from 'vitest'
import { buildBootstrapManifest, carryForwardBasemaps, partitionByReadiness } from './bootstrap.mjs'
import { buildManifest } from './manifest.mjs'

const segments = {
  W5_N55: { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 27262976, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' },
  W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
}

// Needs ['W5_N55'] only.
const centralScotland = {
  id: 'central-scotland', name: 'Central Scotland', bbox: [-5.0, 55.4, -2.4, 56.4],
  basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 86384407, hash: '1c9d4e77', built: '2026-09-08' },
}
// Needs ['W5_N50'] only.
const wessex = {
  id: 'wessex', name: 'Wessex and the South Coast', bbox: [-2.6, 50.5, -0.7, 51.6],
  basemap: { url: 'regions/wessex-2b8e5f11.pmtiles', bytes: 54000000, hash: '2b8e5f11', built: '2026-09-08' },
}
// Needs ['E0_N50', 'W5_N50'] — two segments, so a single missing one is enough to block it.
const kentSussex = {
  id: 'kent-sussex', name: 'Kent and Sussex', bbox: [-0.9, 50.6, 1.6, 51.5],
  basemap: { url: 'regions/kent-sussex-9f0a1b22.pmtiles', bytes: 40000000, hash: '9f0a1b22', built: '2026-09-08' },
}

const picker = { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 }
const generated = '2026-09-11T04:00:00Z'

describe('partitionByReadiness', () => {
  it('puts a region in ready only when every segment its bbox needs is present', () => {
    const { ready, notReady } = partitionByReadiness([centralScotland, wessex], { W5_N55: segments.W5_N55 })
    expect(ready).toEqual([centralScotland])
    expect(notReady).toEqual([wessex])
  })

  it('requires every needed segment, not just one, for a region needing more than one', () => {
    const { ready, notReady } = partitionByReadiness([kentSussex], { W5_N50: segments.W5_N50 })
    expect(ready).toEqual([])
    expect(notReady).toEqual([kentSussex])
  })

  it('preserves input order within each group', () => {
    const { ready, notReady } = partitionByReadiness([wessex, centralScotland, kentSussex], segments)
    expect(ready).toEqual([wessex, centralScotland])
    expect(notReady).toEqual([kentSussex])
  })
})

describe('buildBootstrapManifest', () => {
  it('is a pure pass-through when every region is ready — the steady state', () => {
    const regions = [centralScotland, wessex]
    const { manifest, pending } = buildBootstrapManifest({ regions, segments, picker, generated })
    const direct = buildManifest({ regions, segments, picker, generated })
    expect(manifest).toEqual(direct)
    expect(pending).toEqual([])
  })

  it('carries every region forward with an empty segment list when none are ready — the true bootstrap', () => {
    const regions = [centralScotland, wessex]
    const { manifest, pending } = buildBootstrapManifest({ regions, segments: {}, picker, generated })
    expect(manifest.regions).toEqual([
      { id: 'central-scotland', name: centralScotland.name, bbox: centralScotland.bbox, basemap: centralScotland.basemap, segments: [] },
      { id: 'wessex', name: wessex.name, bbox: wessex.bbox, basemap: wessex.basemap, segments: [] },
    ])
    expect(pending).toEqual(['central-scotland', 'wessex'])
  })

  it('mixes ready and not-ready regions, and names the not-ready ones as pending', () => {
    const regions = [centralScotland, wessex, kentSussex]
    const onlyCentralScotland = { W5_N55: segments.W5_N55 }
    const { manifest, pending } = buildBootstrapManifest({ regions, segments: onlyCentralScotland, picker, generated })
    expect(manifest.regions[0]).toEqual({ ...centralScotland, segments: ['W5_N55'] })
    expect(manifest.regions[1]).toEqual({ id: 'wessex', name: wessex.name, bbox: wessex.bbox, basemap: wessex.basemap, segments: [] })
    expect(manifest.regions[2]).toEqual({ id: 'kent-sussex', name: kentSussex.name, bbox: kentSussex.bbox, basemap: kentSussex.basemap, segments: [] })
    expect(pending).toEqual(['wessex', 'kent-sussex'])
  })

  it('reassembles in the caller\'s region order, not ready-first', () => {
    // wessex (not ready) is listed before central-scotland (ready) here, the opposite of the
    // order partitionByReadiness would group them in.
    const regions = [wessex, centralScotland]
    const onlyCentralScotland = { W5_N55: segments.W5_N55 }
    const { manifest } = buildBootstrapManifest({ regions, segments: onlyCentralScotland, picker, generated })
    expect(manifest.regions.map((r) => r.id)).toEqual(['wessex', 'central-scotland'])
  })

  it('still throws a clear picker error, same as buildManifest, rather than swallowing it', () => {
    expect(() => buildBootstrapManifest({ regions: [centralScotland], segments, picker: null, generated }))
      .toThrow(/picker.*npm run mirror:basemaps/)
  })
})

describe('carryForwardBasemaps', () => {
  const published = [
    { id: 'central-scotland', basemap: centralScotland.basemap },
    { id: 'wessex', basemap: wessex.basemap },
  ]
  // What the weekly job is handed: regions.json entries, with no basemap of their own.
  const listed = [
    { id: 'central-scotland', name: centralScotland.name, bbox: centralScotland.bbox },
    { id: 'wessex', name: wessex.name, bbox: wessex.bbox },
    { id: 'kent-sussex', name: kentSussex.name, bbox: kentSussex.bbox },
  ]

  it('pairs each region with the basemap the monthly job published for it', () => {
    const { regions, missingBasemap } = carryForwardBasemaps(listed.slice(0, 2), published)
    expect(regions).toEqual([
      { ...listed[0], basemap: centralScotland.basemap },
      { ...listed[1], basemap: wessex.basemap },
    ])
    expect(missingBasemap).toEqual([])
  })

  it('names a newly added region instead of stopping the other regions publishing', () => {
    // The fix this exists for: a region in regions.json that cut-basemaps has not reached yet
    // used to throw here, so the whole weekly run published nothing and routing data stopped
    // updating everywhere until the 1st of the month.
    const { regions, missingBasemap } = carryForwardBasemaps(listed, published)
    expect(regions.map((r) => r.id)).toEqual(['central-scotland', 'wessex'])
    expect(missingBasemap).toEqual(['kent-sussex'])
  })

  it('reports every region as missing when the bucket has no manifest at all', () => {
    const { regions, missingBasemap } = carryForwardBasemaps(listed, undefined)
    expect(regions).toEqual([])
    expect(missingBasemap).toEqual(['central-scotland', 'wessex', 'kent-sussex'])
  })

  it('keeps regions.json order rather than the published order', () => {
    const { regions } = carryForwardBasemaps([listed[1], listed[0]], published)
    expect(regions.map((r) => r.id)).toEqual(['wessex', 'central-scotland'])
  })
})
