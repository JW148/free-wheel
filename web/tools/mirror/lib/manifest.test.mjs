import { describe, expect, it } from 'vitest'
import { assertPublishable, buildManifest } from './manifest.mjs'

const segments = {
  W5_N55: { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 27262976, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' },
  W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
}
const regions = [
  { id: 'central-scotland', name: 'Central Scotland', bbox: [-5.0, 55.4, -2.4, 56.4],
    basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 86384407, hash: '1c9d4e77', built: '2026-09-08' } },
]
const picker = { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 }
const generated = '2026-09-11T04:00:00Z'

describe('buildManifest', () => {
  it('derives each region\'s segments from its bbox', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    expect(manifest.regions[0].segments).toEqual(['W5_N55'])
  })

  it('stamps version 1 and carries the picker archive', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    expect(manifest.version).toBe(1)
    expect(manifest.generated).toBe(generated)
    expect(manifest.picker).toEqual(picker)
  })

  it('refuses to build a manifest whose region needs a segment we do not have', () => {
    const orphan = [{ ...regions[0], bbox: [-12.0, 55.4, -11.0, 56.4] }]
    expect(() => buildManifest({ regions: orphan, segments, picker, generated }))
      .toThrow(/W15_N55/)
  })

  it('throws a clear error when picker is missing', () => {
    expect(() => buildManifest({ regions, segments, picker: null, generated }))
      .toThrow(/picker.*npm run mirror:basemaps/)
  })

  it('throws a clear error when picker has no url', () => {
    expect(() => buildManifest({ regions, segments, picker: { bytes: 60959264 }, generated }))
      .toThrow(/picker.*url.*npm run mirror:basemaps/)
  })

  it('throws a clear error when region basemap is missing', () => {
    const noBasemap = [{ ...regions[0], basemap: undefined }]
    expect(() => buildManifest({ regions: noBasemap, segments, picker, generated }))
      .toThrow(/central-scotland.*basemap.*npm run mirror:basemaps/)
  })

  it('throws a clear error when region basemap has no url', () => {
    const noBmUrl = [{ ...regions[0], basemap: { bytes: 86384407, hash: '1c9d4e77' } }]
    expect(() => buildManifest({ regions: noBmUrl, segments, picker, generated }))
      .toThrow(/central-scotland.*basemap.*url.*npm run mirror:basemaps/)
  })
})

describe('assertPublishable', () => {
  it('passes when every named object was uploaded', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    const urls = new Set([picker.url, segments.W5_N55.url, segments.W5_N50.url, regions[0].basemap.url])
    expect(() => assertPublishable(manifest, urls)).not.toThrow()
  })

  it('throws when the manifest names an object that is not in the bucket', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    const urls = new Set([picker.url, segments.W5_N55.url, segments.W5_N50.url])
    expect(() => assertPublishable(manifest, urls)).toThrow(/central-scotland-1c9d4e77/)
  })

  it('throws a clear error when picker url is not uploaded', () => {
    const manifest = buildManifest({ regions, segments, picker, generated })
    const urls = new Set([segments.W5_N55.url, segments.W5_N50.url, regions[0].basemap.url])
    expect(() => assertPublishable(manifest, urls)).toThrow(/basemap\/uk-z10-8f3a1c2d\.pmtiles/)
  })
})
