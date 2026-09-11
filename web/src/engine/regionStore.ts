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
import { openHandle, peekFileSize, refreshSize, removeFile } from './opfsVfs'
import { readRecords, writeRecords } from './regionRecords'
import { BASEMAP_DIR, deleteTile, recordTileInstalled, resetTileStorage, SEGMENT_DIR } from './tileStore'
import { clearDownloading, markDownloading, readPartialHash, type PartialTarget } from './partials'

// Re-exported so a caller assembling `DownloadLoopDeps` has one import for the loop and the
// store it reads. `tileStore.ts` imports straight from `./partials` instead, which is the whole
// reason that module exists: it cannot import this one without a cycle (this file imports
// `tileStore` for `deleteTile`).
export { clearDownloading, markDownloading, readPartialHash } from './partials'
export type { PartialTarget } from './partials'

// Re-exported for the same reason: `/regions.json` is read and written from `regionRecords.ts`
// so that `tileStore.ts` can strip a deleted segment out of the records without importing this
// module, which would be a cycle. Callers of the region API keep one import.
export { readRecords, writeRecords } from './regionRecords'

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

/**
 * `tileStore.deleteTile`, queued behind every other region operation.
 *
 * Deleting a segment is a region operation, even though it is reached from the tile list rather
 * than the picker: `deleteTile` calls `forgetSegments`, which is a read-modify-write of
 * `/regions.json` exactly like `downloadRegion` and `removeRegion`. Unqueued, a delete from Setup that lands between
 * `completeRegionDownload`'s read and its write is discarded by that write — and what comes back
 * is the record the delete had just retracted, claiming a `.rd5` that is no longer on disk. That
 * is the one state the picker offers no way out of, and the reason `forgetSegments` exists.
 *
 * ## Why the wrap is here and not inside `tileStore`
 *
 * `deleteTile` is also reached from *inside* the queue: `removeRegion` runs
 * `deleteRegionFiles`, which deletes each segment that way. `serializeRegionOp` is a plain
 * promise chain with no re-entrancy escape, so a queued call that queues another waits on a
 * link it is itself blocking — `removeRegion` would hang forever, and nothing would time it
 * out. Wrapping at the entry points that are *not* already inside the queue is what avoids
 * that, which means here, called from `engineApi`, rather than in `deleteTile` itself.
 *
 * These live in this module rather than inline in `engineApi.ts` for the reason
 * `completeRegionDownload` does: `engineApi.ts` calls `Comlink.expose()` at module scope and so
 * cannot be imported under vitest, and wiring no test can reach is where these bugs keep
 * living.
 */
export function deleteTileSerialized(tile: string): Promise<void> {
  return serializeRegionOp(() => deleteTile(tile))
}

/**
 * `tileStore.resetTileStorage`, queued for the same reason: its `forgetSegments('all')` is a
 * read-modify-write of `/regions.json`, and a download finishing across it puts back a claim on
 * a segment the reset has just deleted. Wrapped at the same boundary as
 * {@link deleteTileSerialized} — not reachable from inside the queue today, but keeping both
 * entry points wrapped in one place is what stops the next caller guessing.
 */
export function resetTileStorageSerialized(): Promise<string[]> {
  return serializeRegionOp(() => resetTileStorage())
}

/** Where a plan item lands in OPFS. */
export function pathForItem(regionId: string, item: Pick<DownloadItem, 'kind' | 'key'>): string {
  return item.kind === 'basemap'
    ? `${BASEMAP_DIR}/${basemapFileFor(regionId)}`
    : `${SEGMENT_DIR}/${item.key}.rd5`
}

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

/**
 * Deletes a region's files.
 *
 * Segments go through `tileStore.deleteTile` rather than a bare `removeFile`, because that is
 * also what removes the segment's entry from `/segments4/.imported.json` — otherwise a deleted
 * segment's stale age would linger in a manifest nothing else ever cleans up. Deliberately the
 * bare `deleteTile` and not {@link deleteTileSerialized}: this runs inside `removeRegion`'s
 * `serializeRegionOp`, and queueing from in there would deadlock. Basemaps have no
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
  /**
   * Opens (creating if absent) the sink a path's bytes get written into.
   *
   * Called only from inside the download's sink source, once bytes are certain — never to ask a
   * file how big it is. Opening creates the file and registers it with the VFS bridge, and
   * registration is what makes a path visible to BRouter; a plan item that is skipped, or whose
   * fetch fails before the first byte, must leave the filesystem as it found it. Use
   * {@link DownloadLoopDeps.peekSize} for the size.
   */
  openSink(path: string): Promise<ByteSink>
  /**
   * The size of a file that may not exist, without creating or registering it — `-1` when it is
   * not there. `opfsVfs.peekFileSize`.
   */
  peekSize(path: string): Promise<number>
  /** Re-reads a file's size into whatever registry the real implementation keeps. */
  refreshSize(path: string): void
  /**
   * Records that `path` is being written toward `target` — durably and in the live registry,
   * so a file left short is hidden from BRouter either way. See `partials.markDownloading`.
   *
   * Called from inside the download's sink source, never before it: until a response is in
   * hand, the file on disk is untouched and may be a complete, valid older segment. Marking
   * runs *before* `openSink` there, so no window exists in which the file is registered and
   * unmarked — and then a second time, with `started: true`, once the truncate has succeeded.
   * The first call hides the file; only the second authorises a later resume onto its bytes.
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
 * The real OPFS and network surface, in one object.
 *
 * Lives here rather than inline in `engineApi.ts` so that what a test drives is the same object
 * the Worker uses, down to the `openSink` adapter. `engineApi.ts` cannot be imported under
 * vitest — it calls `Comlink.expose()` at module scope — so anything assembled there is wiring
 * no test can reach, and the wiring is where the last two bugs actually lived.
 *
 * A test overrides only `fetchImpl`, and runs the rest against `fakeOpfs.ts`.
 */
export const opfsDownloadDeps: DownloadLoopDeps = {
  async openSink(path: string): Promise<ByteSink> {
    const handle = await openHandle(path)
    return {
      size: () => handle.getSize(),
      truncate: (to) => handle.truncate(to),
      write: (chunk, at) => handle.write(chunk, { at }),
      flush: () => handle.flush(),
    }
  },
  peekSize: peekFileSize,
  refreshSize,
  markDownloading,
  readPartialHash,
  recordSegmentWritten: (name, bytes) => recordTileInstalled(name, bytes, Date.now()),
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
 * ## Nothing happens to a file until its bytes are certain
 *
 * Marking *and opening* both happen inside the sink source `downloadInto` calls once it has a
 * response in hand, immediately before the truncate or first write. Neither happens before the
 * fetch, which is where they used to be:
 *
 * - **Marking** a file an attempt never reached hides one nobody has touched. It may be a
 *   complete, perfectly good older segment the rider has routed on for weeks, and BRouter would
 *   then report no data for an area it has data for.
 * - **Opening** it is just as consequential, and less obvious. `openSink` creates the file if it
 *   is absent and registers it with the VFS bridge, and registration alone is what makes a path
 *   visible to BRouter. Opening up front — which is what the loop did while only the marking was
 *   deferred — un-hid a truncated orphan the moment a retry began, at its short size and with no
 *   marker, and left it that way for the session if the fetch then failed. On a first download
 *   it left a 0-byte file that `installedTiles()` happily listed on every later cold start,
 *   because a path with no durable entry is not truncated as far as `isTruncated` is concerned.
 *
 * So the size `resumeDecision` needs comes from `deps.peekSize`, which neither creates nor
 * registers, and the order inside the source is mark, then open: `markPending` is keyed by path
 * rather than held on the handle precisely so it can run first.
 *
 * `start` and `resume` alike disturb the file once bytes flow, so both mark; `done` touches
 * nothing, opens nothing, and marks nothing.
 *
 * ## A marker that has not started authorises nothing
 *
 * Marking before the open means a marker can outlive an attempt that never touched the file:
 * `openSink` genuinely throws — `openHandle` gives up after about 820 ms when another tab holds
 * the file, and `getFileHandle(create: true)` can fail under storage pressure — and then the
 * durable marker records the *new* hash against the *old* bytes. A retry reading only that
 * would see a hash match and a short file, resume at the old length, and append this month's
 * tail to last month's prefix: a file of exactly the right length made of two different
 * downloads, which is precisely what `resumeDecision`'s hash comparison exists to prevent.
 *
 * So the marker goes down as `started: false` — enough to hide the file, not enough to
 * authorise anything — and is flipped to `true` only once the truncate has succeeded, which is
 * the moment the file stops holding anyone else's bytes. Only a started marker lets
 * `resumeDecision` return `resume` (or `done`). Every way this can be interrupted then errs the
 * same way: a hidden file that the next attempt restarts from zero.
 *
 * Moving the mark *after* the truncate instead would remove the splice and open the opposite
 * window — a file truncated to nothing with no marker saying so, which `installedTiles()` would
 * hand to BRouter on every later cold start. The state field is what makes both orderings
 * unnecessary to choose between.
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
      const recorded = await deps.readPartialHash(path)
      // `peekSize` answers -1 for a file that is not there; to `resumeDecision` that is zero
      // bytes. Passing the -1 through would read as a resume offset of -1. Defensive rather
      // than load-bearing today — `downloadInto` sends no Range header for a non-positive
      // `from`, so the attempt would still restart correctly — which is exactly why the
      // normalisation belongs here, where the contract is, rather than being relied on there.
      const onDisk = Math.max(0, await deps.peekSize(path))
      const decision = resumeDecision(
        { bytes: onDisk, hash: recorded?.hash ?? null, started: recorded?.started === true },
        { bytes: item.bytes, hash: item.hash },
      )

      if (decision.action !== 'done') {
        await downloadInto(
          // Called once the response is in hand and the file is certain to be disturbed, and
          // never if the attempt dies before that. See the doc comment above. Marking precedes
          // opening so the file is never registered — and so never visible — while unmarked,
          // and the flip to `started` follows the truncate for the reason given there.
          //
          // `from` is the offset `downloadInto` will actually write at, which is not always the
          // one asked for: a server that ignores `Range` downgrades a resume to a restart, and
          // that file needs truncating and re-marking like any other restart. A resume proper
          // (`from > 0`) only happens on a marker that already says `started`, so writing it
          // again is restating what is there.
          async (from) => {
            await deps.markDownloading(path, { hash: item.hash, bytes: item.bytes, started: from > 0 })
            const sink = await deps.openSink(path)
            touched = true
            if (from === 0) {
              sink.truncate(0)
              await deps.markDownloading(path, { hash: item.hash, bytes: item.bytes, started: true })
            }
            return sink
          },
          item.url,
          item.bytes,
          {
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
          },
        )
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
