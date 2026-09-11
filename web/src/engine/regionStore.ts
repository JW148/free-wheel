/**
 * What a phone has installed, region by region, and the download loop that gets it there.
 *
 * The pure record functions (`recordAfterDownload`, `recordsAfterRemoval`) and the download
 * loop (`runRegionDownload`) take no OPFS dependency at all: the first two are pure, and the
 * loop reaches storage only through `DownloadLoopDeps`, so a test can hand it a fake sink and a
 * fake fetch. The OPFS-backed functions around them — `readRecords`, `deleteRegionFiles`,
 * `completeRegionDownload` — are tested against `fakeOpfs.ts`, which fakes the browser's OPFS
 * API underneath the real `opfsVfs.ts` rather than mocking `opfsVfs` itself.
 */

import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import type { DownloadItem } from '../data/regions'
import { downloadInto, resumeDecision, type ByteSink, type RegionProgress } from './downloads'
import { openHandle, refreshSize, removeFile } from './opfsVfs'
import { BASEMAP_DIR, deleteTile, SEGMENT_DIR } from './tileStore'
import { clearDownloading, type PartialTarget } from './partials'

// Re-exported so a caller assembling `DownloadLoopDeps` has one import for the loop and the
// store it reads. `tileStore.ts` imports straight from `./partials` instead, which is the whole
// reason that module exists: it cannot import this one without a cycle (this file imports
// `tileStore` for `deleteTile`).
export { clearDownloading, markDownloading, readPartialHash } from './partials'
export type { PartialTarget } from './partials'

/** Where the region records live. Beside the tile manifest, not inside it. */
const RECORDS_PATH = '/regions.json'

/** A region's basemap on this phone. The hash lives in the record, not the file name. */
export const basemapFileFor = (id: string) => `${id}.pmtiles`

/**
 * Serializes calls that mutate region installation state.
 *
 * `downloadRegion` and `removeRegion` both do read-modify-write on `/regions.json` (and, via
 * the partial-hash store, on `/downloads.json`). Two overlapping `downloadRegion` calls would
 * each start from the same snapshot of records, and the second write would silently discard the
 * first region's record — even though its files are still on disk and another region, or a
 * later removal, still needs them. The same overlap can also hole a shared segment: one call
 * truncating a file to 0 while another resumes it at offset N produces a file of the right
 * length with a zero-filled gap in the middle, which `downloadInto`'s length check cannot
 * catch. A single-threaded Worker needs no locks to fix this, just a promise chain every call
 * appends itself to: "one region operation at a time."
 *
 * One queue shared by every caller — a module-level `let`, not something callers thread through
 * — is what makes it a real mutex rather than a per-caller no-op; a queue instantiated fresh
 * inside each call would never see the others.
 */
let regionQueue: Promise<unknown> = Promise.resolve()
export function serializeRegionOp<T>(run: () => Promise<T>): Promise<T> {
  const result = regionQueue.then(run, run)
  // Cleared either way: one call failing must not wedge every one queued after it.
  regionQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** Where a plan item lands in OPFS. */
export function pathForItem(regionId: string, item: Pick<DownloadItem, 'kind' | 'key'>): string {
  return item.kind === 'basemap'
    ? `${BASEMAP_DIR}/${basemapFileFor(regionId)}`
    : `${SEGMENT_DIR}/${item.key}.rd5`
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function recordAfterDownload(
  records: InstalledRegion[],
  region: RegionEntry,
  manifest: DataManifest,
  at: number,
): InstalledRegion[] {
  const segmentHashes: Record<string, string> = {}
  for (const name of region.segments) {
    const entry = manifest.segments[name]
    if (!entry) throw new Error(`${region.id} needs segment ${name}, which the manifest does not describe`)
    segmentHashes[name] = entry.hash
  }
  const record: InstalledRegion = {
    id: region.id,
    basemapHash: region.basemap.hash,
    segmentHashes,
    installedAt: at,
  }
  return [...records.filter((r) => r.id !== region.id), record]
}

/**
 * Removing a region must not remove a segment another one still needs.
 *
 * `W5_N50` covers most of England and Wales, so deleting Wessex while the South West is
 * installed would silently break routing there. The file is 137 MB, so the mistake also
 * costs a long re-download.
 */
export function recordsAfterRemoval(
  records: InstalledRegion[],
  id: string,
): { records: InstalledRegion[]; deleteSegments: string[]; deleteBasemap: string } {
  const going = records.find((r) => r.id === id)
  if (!going) return { records, deleteSegments: [], deleteBasemap: '' }

  const remaining = records.filter((r) => r.id !== id)
  const stillNeeded = new Set(remaining.flatMap((r) => Object.keys(r.segmentHashes)))
  return {
    records: remaining,
    deleteSegments: Object.keys(going.segmentHashes).filter((name) => !stillNeeded.has(name)),
    deleteBasemap: basemapFileFor(id),
  }
}

export async function readRecords(): Promise<InstalledRegion[]> {
  const handle = await openHandle(RECORDS_PATH)
  const size = handle.getSize()
  if (size === 0) return []
  const buffer = new Uint8Array(size)
  handle.read(buffer, { at: 0 })
  try {
    const parsed: unknown = JSON.parse(decoder.decode(buffer))
    return Array.isArray(parsed) ? (parsed as InstalledRegion[]) : []
  } catch {
    return [] // a corrupt record costs a re-download, not a crash
  }
}

export async function writeRecords(records: InstalledRegion[]): Promise<void> {
  const handle = await openHandle(RECORDS_PATH)
  const bytes = encoder.encode(JSON.stringify(records))
  handle.truncate(0)
  handle.write(bytes, { at: 0 })
  handle.flush()
  refreshSize(RECORDS_PATH)
}

/**
 * Deletes a region's files.
 *
 * Segments go through `tileStore.deleteTile` rather than a bare `removeFile`, because that is
 * also what removes the segment's entry from `/segments4/.imported.json` — otherwise a deleted
 * segment's stale age would linger in a manifest nothing else ever cleans up. Basemaps have no
 * equivalent age-tracking manifest, but they do have download markers, so those are cleared
 * here explicitly.
 *
 * Clearing the basemap's markers is arguably unreachable — a region is only recorded, and so
 * only removable, after a download that cleared them — but "arguably unreachable" is the
 * reasoning that produced three rounds of this same bug. A re-download of an already-installed
 * region that dies mid-basemap sets them again while the old record is still in place, and then
 * this is the path that removes the file they describe. A marker whose file is gone must go with
 * it.
 */
export async function deleteRegionFiles(deleteSegments: string[], deleteBasemap: string): Promise<void> {
  for (const name of deleteSegments) await deleteTile(name)
  if (deleteBasemap) {
    const path = `${BASEMAP_DIR}/${deleteBasemap}`
    await removeFile(path)
    await clearDownloading(path)
  }
}

/**
 * The OPFS/network surface `runRegionDownload` needs, and nothing else — what makes the
 * resume/restart/skip dispatch testable with a fake sink and fake fetch instead of real OPFS.
 */
export interface DownloadLoopDeps {
  /** Opens (creating if absent) the sink a path's bytes get written into. */
  openSink(path: string): Promise<ByteSink>
  /** Re-reads a file's size into whatever registry the real implementation keeps. */
  refreshSize(path: string): void
  /**
   * Records that `path` is being written toward `target` — durably and in the live registry,
   * so a file left short is hidden from BRouter either way. See `partials.markDownloading`.
   *
   * Called from inside `downloadInto`'s `onWillWrite` hook, never before it: until a response
   * is in hand, the file on disk is untouched and may be a complete, valid older segment.
   */
  markDownloading(path: string, target: PartialTarget): Promise<void>
  readPartialHash(path: string): Promise<PartialTarget | null>
  /**
   * Called only for a segment actually (re)written during this call — never for one skipped
   * because it was already current. Lets a downloaded segment's age be recorded the same way
   * an imported one's is, without this module depending on how that recording happens.
   */
  recordSegmentWritten(name: string, bytes: number): Promise<void>
  fetchImpl?: typeof fetch
}

/**
 * Downloads every item a region's plan calls for, in order.
 *
 * `deps` is the only OPFS/network surface, which is what makes this testable
 * (`regionStore.test.ts`) without OPFS: `engineApi.ts`'s `downloadRegion` supplies the real
 * handles, fetch, and tile-age recording, and stays thin wiring around this function plus the
 * region-record bookkeeping that has to happen once for the whole region rather than per item.
 *
 * `resumeDecision` is recomputed from `deps.readPartialHash` and the sink's live size
 * immediately before *every* item — never cached across a retry. A retry is exactly a second
 * call to `engineApi.downloadRegion` (the caller sees the rejection and tries again), and each
 * call starts fresh, so a previous attempt's partial or over-long file is judged on what is
 * actually there rather than assumed.
 *
 * ## When an item is marked, and when it is not
 *
 * Marking happens inside `downloadInto`'s `onWillWrite` hook — after the response is in hand,
 * immediately before the truncate or first write. Not before the fetch, which is where it used
 * to be: a download that fails before a single byte lands (an instant network drop, a 404, a
 * server that refuses the range) leaves the file on disk exactly as it was, and that file may be
 * a complete, perfectly good older segment the rider has been routing on for weeks. Marking it
 * would hide it — from BRouter, which would then honestly report no data for an area it has
 * data for, and from `installedTiles()`, which would stop listing it. A file nobody has touched
 * must never be hidden. `start` and `resume` alike disturb the file once bytes flow, so both are
 * marked at that same moment; `done` never touches it and never marks.
 *
 * A marker is deliberately left in place after an item completes, not cleared here:
 * clearing is the caller's job, done only once the whole region is durably recorded as
 * installed. A multi-item region — a basemap plus several segments — commits nothing to
 * `regions.json` until every item is down, so a failure on the last item must not make the
 * earlier, already-correct items look unrecognisable on a retry. If their partial-hash entries
 * were cleared as soon as they individually succeeded, a retry's `resumeDecision` would see a
 * `null` hash where it expects a match and restart them from byte zero — silently re-fetching a
 * 90 MB basemap and a 137 MB segment that were already fine, on every retry after a late
 * failure. Leaving the entry in place until the region-level commit is what lets a retry see
 * `{ action: 'done' }` for those and skip them.
 */
export async function runRegionDownload(
  regionId: string,
  items: DownloadItem[],
  totalBytes: number,
  deps: DownloadLoopDeps,
  onProgress?: (progress: RegionProgress) => void,
): Promise<void> {
  let doneBytes = 0

  for (const item of items) {
    const path = pathForItem(regionId, item)
    // What to report if this item fails: 0 for one never attempted, the partial or complete
    // byte count otherwise — never a hardcoded 0 for an item that may have fetched most of
    // itself before failing.
    let lastReceived = 0
    // Whether this item's bytes were ever disturbed. Drives the failure branch below: there is
    // nothing to re-measure on a file no write ever reached.
    let touched = false

    try {
      const sink = await deps.openSink(path)
      const recorded = await deps.readPartialHash(path)
      const decision = resumeDecision(
        { bytes: sink.size(), hash: recorded?.hash ?? null },
        { bytes: item.bytes, hash: item.hash },
      )

      if (decision.action !== 'done') {
        await downloadInto(sink, item.url, item.bytes, {
          from: decision.action === 'resume' ? decision.at : 0,
          fetchImpl: deps.fetchImpl,
          // Called once the response is in hand and the file is certain to be disturbed, and
          // never if the attempt dies before that. See the doc comment above.
          onWillWrite: async () => {
            await deps.markDownloading(path, { hash: item.hash, bytes: item.bytes })
            touched = true
          },
          onProgress: (received) => {
            lastReceived = received
            onProgress?.({
              key: item.key,
              kind: item.kind,
              received,
              total: item.bytes,
              overallReceived: doneBytes + received,
              overallTotal: totalBytes,
              state: 'downloading',
            })
          },
        })
        deps.refreshSize(path)
        if (item.kind === 'segment') await deps.recordSegmentWritten(item.key, item.bytes)
      }

      doneBytes += item.bytes
      onProgress?.({
        key: item.key, kind: item.kind, received: item.bytes, total: item.bytes,
        overallReceived: doneBytes, overallTotal: totalBytes, state: 'complete',
      })
    } catch (error) {
      // A failed attempt that got as far as writing may have truncated-and-partly-rewritten a
      // file that previously held a full, different version — refreshing brings the registry's
      // cached size back in line with what is actually on disk, so the rest of this session
      // sees an honest (possibly still-pending) size rather than the stale, too-large one from
      // before this attempt. `markDownloading` keeps the bridge from treating a short file as
      // present at all; this is what makes that comparison correct once the size is stale too.
      //
      // Guarded by `touched` for the same reason the marking is: an attempt that never reached
      // a write left the file alone, and the registry's size for it is not stale.
      if (touched) deps.refreshSize(path)
      onProgress?.({
        key: item.key, kind: item.kind, received: lastReceived, total: item.bytes,
        overallReceived: doneBytes + lastReceived, overallTotal: totalBytes, state: 'failed',
      })
      throw error
    }
  }
}

/**
 * Forgets every download marker a region's plan set, now that the region is durably recorded.
 *
 * Separate from `runRegionDownload` because the timing is the whole point: a region commits
 * nothing until *every* item is down, so clearing an item's marker the moment that item
 * finishes would make a retry after a late failure restart the items that were already fine.
 * Clearing has to wait for the region-level write, which is the caller's to do — but it must
 * not be forgotten there either, so it is a named function with a test rather than a loop
 * inlined in the Worker API where nothing can reach it.
 */
export async function clearRegionMarkers(regionId: string, items: DownloadItem[]): Promise<void> {
  for (const item of items) await clearDownloading(pathForItem(regionId, item))
}

/**
 * Commits a finished region download: records the region, then forgets its download markers.
 *
 * That order is the point, and it is why this is a function rather than three lines in the
 * Worker API where no test can reach it. The markers are what keep a half-written file away
 * from BRouter, so they may only be dropped once `regions.json` durably says the region is
 * installed. Cleared first and interrupted, the phone would hold a truncated segment that
 * nothing marks as truncated and no record accounts for — a file BRouter would happily open
 * and read as corrupt data.
 */
export async function completeRegionDownload(
  region: RegionEntry,
  manifest: DataManifest,
  items: DownloadItem[],
  at: number,
): Promise<InstalledRegion[]> {
  // Re-read rather than reusing the caller's snapshot: belt and braces on top of
  // `serializeRegionOp`, not a substitute for it.
  const fresh = await readRecords()
  const updated = recordAfterDownload(fresh, region, manifest, at)
  await writeRecords(updated)
  await clearRegionMarkers(region.id, items)
  return updated
}
