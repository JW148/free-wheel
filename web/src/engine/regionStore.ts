/**
 * What a phone has installed, region by region.
 *
 * The pure record functions (`recordAfterDownload`, `recordsAfterRemoval`) are the part worth
 * testing in isolation: they decide what changes, never touch OPFS, and run identically on
 * the main thread or in the Worker. The OPFS-backed reader/writer functions around them are
 * thin and untested here — OPFS does not exist under vitest — and are exercised for real only
 * through the engine Worker.
 */

import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import { openHandle, refreshSize, removeFile } from './opfsVfs'
import { BASEMAP_DIR, SEGMENT_DIR } from './tileStore'

/** Where the region records live. Beside the tile manifest, not inside it. */
const RECORDS_PATH = '/regions.json'

/** A region's basemap on this phone. The hash lives in the record, not the file name. */
export const basemapFileFor = (id: string) => `${id}.pmtiles`

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function recordAfterDownload(
  records: InstalledRegion[],
  region: RegionEntry,
  manifest: DataManifest,
  at: number,
): InstalledRegion[] {
  const segmentHashes: Record<string, string> = {}
  for (const name of region.segments) segmentHashes[name] = manifest.segments[name].hash
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

export async function deleteRegionFiles(deleteSegments: string[], deleteBasemap: string): Promise<void> {
  for (const name of deleteSegments) await removeFile(`${SEGMENT_DIR}/${name}.rd5`)
  if (deleteBasemap) await removeFile(`${BASEMAP_DIR}/${deleteBasemap}`)
}

/**
 * A path-to-hash map for files currently mid-download.
 *
 * `resumeDecision` needs to tell a half-written *current* file from a half-written *older*
 * one, and byte count alone can't do that — a stale partial can happen to be shorter than the
 * new target too. Recording the hash we started writing at closes that gap. Backed by its own
 * file rather than folded into `regions.json`: a region is only recorded as installed once
 * every one of its items is complete, so there is no installed-region state to attach an
 * in-progress hash to.
 */
const PARTIALS_PATH = '/downloads.json'

async function readPartials(): Promise<Record<string, string>> {
  const handle = await openHandle(PARTIALS_PATH)
  const size = handle.getSize()
  if (size === 0) return {}
  const buffer = new Uint8Array(size)
  handle.read(buffer, { at: 0 })
  try {
    return JSON.parse(decoder.decode(buffer)) as Record<string, string>
  } catch {
    return {}
  }
}

async function writePartials(partials: Record<string, string>): Promise<void> {
  const handle = await openHandle(PARTIALS_PATH)
  const bytes = encoder.encode(JSON.stringify(partials))
  handle.truncate(0)
  handle.write(bytes, { at: 0 })
  handle.flush()
  refreshSize(PARTIALS_PATH)
}

export async function readPartialHash(path: string): Promise<string | null> {
  return (await readPartials())[path] ?? null
}

export async function writePartialHash(path: string, hash: string): Promise<void> {
  const partials = await readPartials()
  partials[path] = hash
  await writePartials(partials)
}

export async function clearPartialHash(path: string): Promise<void> {
  const partials = await readPartials()
  delete partials[path]
  await writePartials(partials)
}
