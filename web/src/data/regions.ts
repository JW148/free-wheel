/**
 * What a region costs to download, and whether an installed copy is still current.
 *
 * Pure by design: this module runs on the main thread and in the engine Worker, so no
 * `localStorage`, no DOM, no `fetch` here.
 */

import { assetUrl } from './origin'
import type { DataManifest, InstalledRegion, RegionEntry } from './manifest'

export type RegionState =
  | 'not-installed'
  | 'current'
  | 'road-data-outdated'
  | 'map-outdated'
  | 'unknown'

export interface DownloadItem {
  kind: 'basemap' | 'segment'
  /** Region id for a basemap, segment name for a segment. */
  key: string
  url: string
  bytes: number
  hash: string
}

/**
 * Whether an installed region still matches the mirror.
 *
 * `unknown` exists because an offline phone has no way to tell, and claiming `current` would
 * be a guess dressed as a fact. Road data leads when both are stale: an old basemap is a
 * cosmetic problem, and an old segment routes you down a road that is not there.
 *
 * `segments` is the manifest's segment table, not the region's own list of names — a region
 * only names which segments it needs, and the current hash for each lives in the manifest. If
 * the manifest no longer describes a segment the region declares, that reads as stale road
 * data rather than throwing: `segments[name]?.hash` is `undefined`, which cannot equal an
 * installed hash string, so it falls into `road-data-outdated` the same as any other mismatch.
 * `downloadPlan` below disagrees on purpose for this same input — see its doc comment for why.
 */
export function regionState(
  region: RegionEntry,
  installed: InstalledRegion | undefined,
  manifestIsFresh: boolean,
  segments: DataManifest['segments'],
): RegionState {
  if (!installed) return 'not-installed'
  if (!manifestIsFresh) return 'unknown'
  const roadDataStale = region.segments.some(
    (name) => installed.segmentHashes[name] !== segments[name]?.hash,
  )
  if (roadDataStale) return 'road-data-outdated'
  if (installed.basemapHash !== region.basemap.hash) return 'map-outdated'
  return 'current'
}

/**
 * What actually has to be downloaded, in the order it should happen.
 *
 * Segments are shared: `W5_N50` covers most of England and Wales, so a rider who already has
 * Wessex should not download 137 MB again for the South West. `installed` is every region a
 * phone already holds, not just this one, so that sharing works.
 *
 * Unlike `regionState`, this throws if a region declares a segment `manifest.segments` does
 * not describe, instead of treating it as merely stale: a status query has a safe default
 * (call it outdated and move on), but this function has to hand back a concrete `url` and
 * `bytes` for every item, and there is no safe value to invent for one it can't find. A caller
 * that just saw `regionState` report `road-data-outdated` for this same input and then calls
 * `downloadPlan` to act on it should not be surprised by an uncaught throw. In practice this is
 * unreachable through `parseManifest` (`web/src/data/manifest.ts:110`), which rejects a region
 * referencing an undescribed segment at parse time — so this only guards against a manually
 * constructed or mismatched manifest, and stays a live concern only for as long as that check
 * does.
 */
export function downloadPlan(
  region: RegionEntry,
  manifest: DataManifest,
  installed: InstalledRegion[],
): { items: DownloadItem[]; bytes: number } {
  const mine = installed.find((r) => r.id === region.id)
  const items: DownloadItem[] = []

  if (mine?.basemapHash !== region.basemap.hash) {
    items.push({
      kind: 'basemap',
      key: region.id,
      url: assetUrl(region.basemap.url),
      bytes: region.basemap.bytes,
      hash: region.basemap.hash,
    })
  }

  for (const name of region.segments) {
    const entry = manifest.segments[name]
    if (!entry) throw new Error(`${region.id} needs segment ${name}, which the manifest does not describe`)
    const haveCurrent = installed.some((r) => r.segmentHashes[name] === entry.hash)
    if (haveCurrent) continue
    items.push({
      kind: 'segment',
      key: name,
      url: assetUrl(entry.url),
      bytes: entry.bytes,
      hash: entry.hash,
    })
  }

  return { items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
}
