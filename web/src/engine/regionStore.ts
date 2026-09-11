/**
 * What a phone has installed, region by region, and the download loop that gets it there.
 *
 * The pure record functions (`recordAfterDownload`, `recordsAfterRemoval`) and the download
 * loop (`runRegionDownload`) are the parts worth testing in isolation: none of them touch OPFS
 * directly, so they run identically under vitest and inside the engine Worker. The OPFS-backed
 * reader/writer functions around them are thin and untested here — OPFS does not exist under
 * vitest — and are exercised for real only through the engine Worker.
 */

import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import type { DownloadItem } from '../data/regions'
import { downloadInto, resumeDecision, type ByteSink, type RegionProgress } from './downloads'
import { openHandle, refreshSize, removeFile } from './opfsVfs'
import { BASEMAP_DIR, deleteTile, SEGMENT_DIR } from './tileStore'
import type { PartialTarget } from './partials'

// Re-exported so code that already imports the partial-hash store from here — the shape this
// module had before it grew a `partials.ts` sibling — keeps working. `tileStore.ts` imports
// straight from `./partials` instead, which is the whole reason that module exists: it cannot
// import this one without a cycle (this file imports `tileStore` for `deleteTile`).
export { clearPartialHash, readPartialHash, writePartialHash } from './partials'
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
 * equivalent age-tracking manifest, so a plain `removeFile` is enough for those.
 */
export async function deleteRegionFiles(deleteSegments: string[], deleteBasemap: string): Promise<void> {
  for (const name of deleteSegments) await deleteTile(name)
  if (deleteBasemap) await removeFile(`${BASEMAP_DIR}/${deleteBasemap}`)
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
   * Marks `path` as not yet reaching `bytes`, so the same-session VFS bridge treats it as
   * absent until the real size catches up — see `opfsVfs.markPending`. A no-op for the fake
   * deps in tests that don't model the bridge at all.
   */
  markPending(path: string, bytes: number): void
  readPartialHash(path: string): Promise<PartialTarget | null>
  writePartialHash(path: string, target: PartialTarget): Promise<void>
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
 * A partial-hash entry is deliberately left in place after an item completes, not cleared here:
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

    try {
      const sink = await deps.openSink(path)
      const recorded = await deps.readPartialHash(path)
      const decision = resumeDecision(
        { bytes: sink.size(), hash: recorded?.hash ?? null },
        { bytes: item.bytes, hash: item.hash },
      )

      if (decision.action !== 'done') {
        await deps.writePartialHash(path, { hash: item.hash, bytes: item.bytes })
        // Same-session guard: until this write finishes, the file must not answer as present
        // and full-length to anything reading through the VFS bridge in *this* session — see
        // `opfsVfs.markPending`.
        deps.markPending(path, item.bytes)
        await downloadInto(sink, item.url, item.bytes, {
          from: decision.action === 'resume' ? decision.at : 0,
          fetchImpl: deps.fetchImpl,
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
      // A failed attempt may have truncated-and-partly-rewritten a file that previously held a
      // full, different version — refreshing brings the registry's cached size back in line
      // with what is actually on disk, so the rest of this session sees an honest (possibly
      // still-pending) size rather than the stale, too-large one from before this attempt.
      // `markPending` above already keeps the bridge from treating a short file as present at
      // all; this is what makes that comparison correct once the size itself is stale too.
      deps.refreshSize(path)
      onProgress?.({
        key: item.key, kind: item.kind, received: lastReceived, total: item.bytes,
        overallReceived: doneBytes + lastReceived, overallTotal: totalBytes, state: 'failed',
      })
      throw error
    }
  }
}
