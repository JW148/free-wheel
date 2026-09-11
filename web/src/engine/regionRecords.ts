/**
 * The durable record of what regions this phone has installed, and the only writes to it.
 *
 * Split out of `regionStore.ts` for the same reason `partials.ts` was: `tileStore.ts` has to
 * write here too — deleting a segment has to un-record it — and `regionStore.ts` already
 * imports `tileStore.ts` for `deleteTile`, so the reverse import is not available. Everything
 * in `regionStore.ts` that reads or writes `/regions.json` goes through this module, and it
 * re-exports {@link readRecords} and {@link writeRecords} so callers keep one import.
 */

import type { InstalledRegion } from '../data/manifest'
import { openHandle, refreshSize } from './opfsVfs'

/** Where the region records live. Beside the tile manifest, not inside it. */
const RECORDS_PATH = '/regions.json'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

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
 * Drops a segment's hash from every region that claims it, because the file is gone.
 *
 * A record is a claim about bytes on disk, and a segment is shared: `W5_N50` can be claimed by
 * four regions at once, so the claim has to come out of all of them, not just the region whose
 * removal happened to delete the file. Left in place, the record goes on asserting a segment
 * that is not there — `regionState` reads `current` because the hashes still match, the picker
 * never offers the region again, and `downloadPlan` skips the segment for *every* region
 * because some other record still claims it. The rider gets a working basemap and BRouter
 * reporting no segment directory, with no way out but the manual escape hatch.
 *
 * Dropping the hash instead makes the same records say something true: the region reads
 * `road-data-outdated` and its plan re-fetches exactly the file that went missing, its basemap
 * untouched.
 *
 * @param names the segments removed, e.g. `['W5_N50']`, or `'all'` when storage was reset
 */
export async function forgetSegments(names: string[] | 'all'): Promise<void> {
  const records = await readRecords()
  const going = names === 'all' ? null : new Set(names)

  let changed = false
  const updated = records.map((record) => {
    const hashes = record.segmentHashes ?? {}
    const kept = Object.fromEntries(
      Object.entries(hashes).filter(([name]) => (going ? !going.has(name) : false)),
    )
    if (Object.keys(kept).length === Object.keys(hashes).length) return record
    changed = true
    return { ...record, segmentHashes: kept }
  })

  // Nothing to say, so nothing is written: a delete of a segment no region claims must not
  // rewrite `/regions.json` for the sake of it.
  if (changed) await writeRecords(updated)
}
