import { segmentsForBbox } from './geometry.mjs'

/**
 * Assembles the single document every client reads.
 *
 * Region segments are computed here rather than on the phone so that the bucket and the app
 * cannot disagree about what a region needs. The app can still derive them as a check.
 */
export function buildManifest({ regions, segments, picker, generated }) {
  if (!picker || !picker.url) {
    throw new Error('picker is missing or has no url. Run: npm run mirror:basemaps')
  }

  return {
    version: 1,
    generated,
    picker,
    segments,
    regions: regions.map((region) => {
      if (!region.basemap || !region.basemap.url) {
        throw new Error(`${region.id} has no basemap or basemap url. Run: npm run mirror:basemaps`)
      }
      const needed = segmentsForBbox(region.bbox)
      const missing = needed.filter((name) => !segments[name])
      if (missing.length) {
        throw new Error(`${region.id} needs ${missing.join(', ')}, which the mirror does not have`)
      }
      return {
        id: region.id,
        name: region.name,
        bbox: region.bbox,
        basemap: region.basemap,
        segments: needed,
      }
    }),
  }
}

/**
 * The one failure that breaks every client at once is a manifest naming an object that is
 * not uploaded yet, so the manifest is written last and only after this passes.
 */
export function assertPublishable(manifest, uploadedUrls) {
  const named = [
    manifest.picker.url,
    ...Object.values(manifest.segments).map((s) => s.url),
    ...manifest.regions.map((r) => r.basemap.url),
  ]
  const missing = named.filter((url) => !uploadedUrls.has(url))
  if (missing.length) {
    throw new Error(`manifest names objects that are not in the bucket: ${missing.join(', ')}`)
  }
}
