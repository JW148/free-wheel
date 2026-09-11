/**
 * Tracks files mid-download: which OPFS path is being written toward which hash and target
 * byte count.
 *
 * Backed by its own blob (`/downloads.json`) rather than folded into `regions.json`: a region
 * is only durably recorded as installed once every one of its items is complete, so there is no
 * installed-region state to attach an in-progress hash to.
 *
 * Lives in its own module, not inside `regionStore.ts`, so `tileStore.ts` can read it too
 * without a cycle: `installedTiles()` needs to know a file's *target* size to tell an
 * interrupted download from a real tile, and `regionStore.ts` already imports from `tileStore`
 * (for `SEGMENT_DIR`/`BASEMAP_DIR`/`deleteTile`), so the reverse import isn't available.
 *
 * An entry deliberately outlives a single item's success: `regionStore.completeRegionDownload`
 * clears it only once the *whole region* is durably recorded, not as each item finishes — see
 * `runRegionDownload`'s doc comment for why. So a path having an entry here is not, by itself,
 * proof that path is incomplete. Only {@link isTruncated}, which compares against the file's
 * live size, can say that.
 *
 * Never write to the durable store alone: {@link markDownloading} and {@link clearDownloading}
 * move it and the registry's in-memory `targetSize` together, and the two drifting apart is
 * what every bug this mechanism has produced was made of.
 */

import { clearPending, markPending, openHandle, peekFileSize, refreshSize } from './opfsVfs'

const PARTIALS_PATH = '/downloads.json'

export interface PartialTarget {
  hash: string
  bytes: number
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

async function readPartials(): Promise<Record<string, PartialTarget>> {
  const handle = await openHandle(PARTIALS_PATH)
  const size = handle.getSize()
  if (size === 0) return {}
  const buffer = new Uint8Array(size)
  handle.read(buffer, { at: 0 })
  try {
    return JSON.parse(decoder.decode(buffer)) as Record<string, PartialTarget>
  } catch {
    return {}
  }
}

async function writePartials(partials: Record<string, PartialTarget>): Promise<void> {
  const handle = await openHandle(PARTIALS_PATH)
  const bytes = encoder.encode(JSON.stringify(partials))
  handle.truncate(0)
  handle.write(bytes, { at: 0 })
  handle.flush()
  refreshSize(PARTIALS_PATH)
}

export async function readPartialHash(path: string): Promise<PartialTarget | null> {
  return (await readPartials())[path] ?? null
}

async function writePartialHash(path: string, target: PartialTarget): Promise<void> {
  const partials = await readPartials()
  partials[path] = target
  await writePartials(partials)
}

async function clearPartialHash(path: string): Promise<void> {
  const partials = await readPartials()
  delete partials[path]
  await writePartials(partials)
}

/**
 * Marks a path as being written toward `target`, in both places that hide a short file: this
 * durable store (which survives a restart, and is what {@link isTruncated} reads) and the live
 * handle registry's `targetSize` (which is what the VFS bridge consults within the session).
 *
 * One function for both because they state the same fact, and three rounds of bugs on this
 * mechanism have all been one marker outliving the other or outliving the write itself. Setting
 * or clearing them separately is the mistake; there is no call site that wants only one.
 *
 * The durable half goes first here, and first in {@link clearDownloading} too — the same order
 * both ways, not a mirror image. The reason is that the durable half is the one that can fail:
 * it is an OPFS write, while the in-memory half cannot throw. Moving the fallible half first
 * and the infallible half only once it has committed is what keeps the two from disagreeing.
 * A throw part-way through either function leaves both markers in their *previous* state,
 * which is consistent; and a crash leaves only whatever the durable store holds, since the
 * in-memory half does not survive the Worker either way.
 *
 * **Call only once the bytes are actually about to be disturbed** — see
 * `regionStore.runRegionDownload`. A download that fails before its first write must leave no
 * trace, because the file it did not touch may be a complete, perfectly good older segment.
 */
export async function markDownloading(path: string, target: PartialTarget): Promise<void> {
  await writePartialHash(path, target)
  markPending(path, target.bytes)
}

/**
 * Forgets that a path was ever mid-download. The counterpart to {@link markDownloading}, and
 * the answer to "what makes this file visible again?" for every way a file can be hidden:
 * a completed region download, a hand import over the same path, a tile delete, a storage
 * reset, and a region removal all call it.
 */
export async function clearDownloading(path: string): Promise<void> {
  await clearPartialHash(path)
  clearPending(path)
}

/**
 * Whether the file at `path` falls short of the target its partial-download entry names.
 *
 * `false` for a path with no entry at all — nothing here is tracking it, so it is whatever it
 * is, the same as an imported tile. Uses {@link peekFileSize}, not `openHandle`: a file this
 * rejects must never be opened, because opening is what registers a path with the VFS bridge,
 * and an orphaned truncated segment must not become visible to BRouter as a present-but-corrupt
 * file — it has to report absent, the same as if it had never been there.
 */
export async function isTruncated(path: string): Promise<boolean> {
  const target = await readPartialHash(path)
  if (!target) return false
  const liveBytes = await peekFileSize(path)
  return liveBytes < target.bytes
}
