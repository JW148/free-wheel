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
 * An entry deliberately outlives a single item's success: `regionStore.ts`'s `downloadRegion`
 * clears it only once the *whole region* is durably recorded, not as each item finishes — see
 * that function's doc comment for why. So a path having an entry here is not, by itself, proof
 * that path is incomplete. Only {@link isTruncated}, which compares against the file's live
 * size, can say that.
 */

import { openHandle, peekFileSize, refreshSize } from './opfsVfs'

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

export async function writePartialHash(path: string, target: PartialTarget): Promise<void> {
  const partials = await readPartials()
  partials[path] = target
  await writePartials(partials)
}

export async function clearPartialHash(path: string): Promise<void> {
  const partials = await readPartials()
  delete partials[path]
  await writePartials(partials)
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
