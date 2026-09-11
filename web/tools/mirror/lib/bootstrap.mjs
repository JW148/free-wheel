import { segmentsForBbox } from './geometry.mjs'
import { buildManifest } from './manifest.mjs'

/**
 * Splits regions into those whose segments are already mirrored — safe to hand to
 * `buildManifest`, which refuses a region missing even one — and those that are not. The
 * second group is only ever non-empty before `sync-segments.mjs` has completed for the first
 * time, or right after a region is added to `regions.json`. Order is preserved within each
 * group, matching the input.
 */
export function partitionByReadiness(regions, segments) {
  const ready = []
  const notReady = []
  for (const region of regions) {
    const complete = segmentsForBbox(region.bbox).every((name) => segments?.[name])
    ;(complete ? ready : notReady).push(region)
  }
  return { ready, notReady }
}

/**
 * Builds a manifest `cut-basemaps.mjs` can always publish, even on a bucket where no segment
 * has ever been mirrored. `buildManifest` refuses a region whose segments aren't all already
 * present — correct once `sync-segments.mjs` has ever run, since it always covers every
 * region's full segment set from then on, but fatal on a first run where nothing has been
 * synced yet. That would leave `cut-basemaps.mjs` unable to record the basemaps it just cut,
 * and `sync-segments.mjs` unable to run next because it requires every region's basemap to
 * already be on record — a deadlock neither script can break alone.
 *
 * The fix: pass only the ready regions through `buildManifest`, which is the whole of `regions`
 * in the steady state (this function is then a pure pass-through — see the tests). Regions not
 * yet ready are carried forward with an empty segment list instead of refused, and the result is
 * reassembled in the caller's own region order, not "ready" first, so a pending region doesn't
 * jump to the end of the picker's list. The next `mirror:segments` run fills every one of them
 * in and republishes a complete manifest.
 */
export function buildBootstrapManifest({ regions, segments, picker, generated }) {
  const { ready, notReady } = partitionByReadiness(regions, segments)
  const built = buildManifest({ regions: ready, segments, picker, generated })
  const byId = new Map(built.regions.map((region) => [region.id, region]))

  const manifest = {
    ...built,
    regions: regions.map((region) => byId.get(region.id) ?? {
      id: region.id,
      name: region.name,
      bbox: region.bbox,
      basemap: region.basemap,
      segments: [],
    }),
  }

  return { manifest, pending: notReady.map((region) => region.id) }
}

/**
 * Pairs every region with the basemap `cut-basemaps.mjs` last published for it, and names the
 * ones that have none.
 *
 * `sync-segments.mjs` never cuts a basemap — only `cut-basemaps.mjs` does — so a region added
 * to `regions.json` since the last basemap run has segments the segment sync can mirror and no
 * map to go with them. That region is named rather than published, and publishing stops for it
 * alone: refusing the whole run, which is what this replaced, meant that adding a region
 * silently stopped every *other* region's routing data from updating until the next basemap
 * run — which, with nothing scheduled, may be months.
 *
 * Order is preserved, so the picker's region order stays the one `regions.json` gives.
 */
export function carryForwardBasemaps(regions, previousRegions) {
  const ready = []
  const missingBasemap = []
  for (const region of regions) {
    const existing = previousRegions?.find((r) => r.id === region.id)
    if (!existing?.basemap) {
      missingBasemap.push(region.id)
      continue
    }
    ready.push({ ...region, basemap: existing.basemap })
  }
  return { regions: ready, missingBasemap }
}
