import { listDirectoryEntries, openHandle, refreshSize, removeFile } from './opfsVfs'
import { clearDownloading, isTruncated } from './partials'

/**
 * Tile storage — records of what has landed in OPFS, for both ways a tile gets there.
 *
 * The primary path is `regionStore.ts`: a rider picks a region and the mirror streams its
 * basemap and segments down, built on the primitives this file owns (`SEGMENT_DIR`,
 * `BASEMAP_DIR`, {@link deleteTile}, {@link recordTileInstalled}). The app never fetches from
 * brouter.de directly, in either path — it serves no `Access-Control-Allow-Origin` header, so a
 * browser could not anyway. The manual route below stays as an escape hatch: the user fetches a
 * `.rd5` or `.pmtiles` themselves and imports it, for a mirror outage or a custom extract the
 * region list does not cover.
 *
 * ## Staleness
 *
 * Everything the mirror publishes is content-addressed: an object's name carries a hash of its
 * bytes, so a client is offered an update only when the bytes actually differ, not merely when
 * brouter.de last rebuilt them (which is weekly, regardless of whether anything changed). A
 * manually imported file carries no such hash and cannot be compared this way — it is a
 * snapshot that will not update itself, and {@link installedTiles} reports when it was imported
 * so the UI can show the gap rather than leaving the user to guess.
 */

/** Where tiles live inside OPFS. Must match `Router.SEGMENT_DIR` on the Java side. */
export const SEGMENT_DIR = '/segments4'

/** Where basemap archives live inside OPFS. */
export const BASEMAP_DIR = '/basemap'

/**
 * Records what was imported and when.
 *
 * OPFS could in principle supply size and mtime via `getFile()`, but the semantics of calling
 * that on a file holding an open sync access handle are not something to rely on — the handle
 * takes an exclusive lock. A tiny manifest sidesteps the question.
 */
const MANIFEST_PATH = `${SEGMENT_DIR}/.imported.json`

export interface ImportProgress {
  tile: string
  received: number
  total: number
  state: 'importing' | 'complete' | 'failed'
  detail?: string
}

export interface InstalledTile {
  tile: string
  bytes: number
  /**
   * When this file was imported, as epoch milliseconds — or `null` if it predates the
   * manifest or was written by something other than an import.
   */
  importedAt: number | null
}

type Manifest = Record<string, { bytes: number; importedAt: number }>

const decoder = new TextDecoder()
const encoder = new TextEncoder()

async function readManifest(): Promise<Manifest> {
  const handle = await openHandle(MANIFEST_PATH)
  const size = handle.getSize()
  if (size === 0) return {}
  const buffer = new Uint8Array(size)
  handle.read(buffer, { at: 0 })
  try {
    return JSON.parse(decoder.decode(buffer)) as Manifest
  } catch {
    return {} // a corrupt manifest costs a re-import, not a crash
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  const handle = await openHandle(MANIFEST_PATH)
  const bytes = encoder.encode(JSON.stringify(manifest))
  handle.truncate(0)
  handle.write(bytes, { at: 0 })
  handle.flush()
  refreshSize(MANIFEST_PATH)
}

/**
 * Imports a `.rd5` the user downloaded themselves, straight into OPFS.
 *
 * Streamed rather than buffered — these files reach 250 MB, and `file.arrayBuffer()` on a
 * phone would be a needless memory spike.
 *
 * @returns the tile name, e.g. `W5_N50`
 */
export async function importTileFile(
  file: File,
  onProgress?: (progress: ImportProgress) => void,
): Promise<string> {
  const match = /^([EW]\d{1,3}_[NS]\d{1,2})\.rd5$/i.exec(file.name)
  if (!match) {
    throw new Error(
      `"${file.name}" is not a segment file. Expected a name like W5_N50.rd5 — the tile's ` +
        `south-west corner. The name is what tells the router which part of the world the ` +
        `data covers, so it has to be the one brouter.de gave it.`,
    )
  }
  const tile = match[1].toUpperCase()

  if (file.size < 1024) {
    throw new Error(`${file.name} is only ${file.size} bytes — that is not a segment file.`)
  }

  const path = `${SEGMENT_DIR}/${tile}.rd5`
  const handle = await openHandle(path)

  onProgress?.({ tile, received: 0, total: file.size, state: 'importing' })

  let offset = 0
  try {
    // Truncate only once the stream is known to be readable, so a failed import does not
    // destroy a working tile that was already present.
    const reader = file.stream().getReader()
    handle.truncate(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      handle.write(value, { at: offset })
      offset += value.byteLength
      onProgress?.({ tile, received: offset, total: file.size, state: 'importing' })
    }
  } finally {
    handle.flush()
    refreshSize(path)
  }

  if (offset !== file.size) {
    throw new Error(`${tile}: expected ${file.size} bytes, wrote ${offset}`)
  }

  const manifest = await readManifest()
  manifest[tile] = { bytes: offset, importedAt: Date.now() }
  await writeManifest(manifest)

  // A hand import can land on the same path a previously interrupted download was writing
  // toward — brouter.de rebuilds weekly, so an import is essentially never byte-identical to
  // whatever the mirror snapshot the markers recorded. Left in place, they would measure this
  // complete, correct file against that unrelated target forever: `isTruncated` would keep it
  // out of `installedTiles()` across restarts, and the registry's `targetSize` would make the
  // VFS bridge answer BRouter "no such file" for the rest of the session even while the UI
  // listed it as installed. `clearDownloading` is what makes the import the last word.
  await clearDownloading(path)

  onProgress?.({ tile, received: offset, total: offset, state: 'complete' })
  return tile
}

/**
 * Imports a `.pmtiles` basemap archive.
 *
 * Same reasoning as routing tiles — the user supplies the file, so there is nothing to host
 * and no cross-origin request. Unlike `.rd5` the name carries no meaning to the renderer, so
 * any name is accepted; it is only an identifier the map refers to.
 */
export async function importBasemapFile(
  file: File,
  onProgress?: (progress: ImportProgress) => void,
): Promise<string> {
  if (!/\.pmtiles$/i.test(file.name)) {
    throw new Error(`"${file.name}" is not a .pmtiles archive.`)
  }
  if (file.size < 1024) {
    throw new Error(`${file.name} is only ${file.size} bytes — that is not a PMTiles archive.`)
  }

  const path = `${BASEMAP_DIR}/${file.name}`
  const handle = await openHandle(path)
  onProgress?.({ tile: file.name, received: 0, total: file.size, state: 'importing' })

  let offset = 0
  try {
    const reader = file.stream().getReader()
    handle.truncate(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      handle.write(value, { at: offset })
      offset += value.byteLength
      onProgress?.({ tile: file.name, received: offset, total: file.size, state: 'importing' })
    }
  } finally {
    handle.flush()
    refreshSize(path)
  }

  if (offset !== file.size) {
    throw new Error(`${file.name}: expected ${file.size} bytes, wrote ${offset}`)
  }

  // Same reasoning as importTileFile: a region basemap download that died mid-file leaves both
  // markers recording the mirror's target byte count, and a hand-imported archive at the same
  // path is essentially never that exact size. Left in place, they would hide this complete,
  // correct import from `installedBasemaps()` — across restarts and within this session.
  await clearDownloading(path)

  onProgress?.({ tile: file.name, received: offset, total: offset, state: 'complete' })
  return file.name
}

/** Basemap archives currently in OPFS. */
export async function installedBasemaps(): Promise<{ name: string; bytes: number }[]> {
  const names = await listDirectoryEntries(BASEMAP_DIR)
  const result: { name: string; bytes: number }[] = []
  for (const name of names) {
    if (!/\.pmtiles$/i.test(name)) continue
    const path = `${BASEMAP_DIR}/${name}`

    // Same reasoning as installedTiles(): a region basemap an interrupted download left short
    // of its target must not reach PMTiles as a short, unreadable archive.
    if (await isTruncated(path)) continue

    const handle = await openHandle(path)
    result.push({ name, bytes: handle.getSize() })
  }
  return result
}

/** Removes a tile from OPFS and forgets it. */
export async function deleteTile(tile: string): Promise<void> {
  const path = `${SEGMENT_DIR}/${tile}.rd5`
  await removeFile(path)
  await clearDownloading(path)
  const manifest = await readManifest()
  delete manifest[tile]
  await writeManifest(manifest)
}

/**
 * Records that a segment now has fresh bytes on disk, however they got there.
 *
 * Import and download both count. `installedTiles()` reports `importedAt: null` for a tile
 * this manifest doesn't know about, and a region download deserves the same "how old is this"
 * surfacing an import gets — the whole point of tracking age at all is that segments go stale,
 * and hiding a downloaded one's age would violate the rule the imported ones are held to.
 */
export async function recordTileInstalled(tile: string, bytes: number, at: number): Promise<void> {
  const manifest = await readManifest()
  manifest[tile] = { bytes, importedAt: at }
  await writeManifest(manifest)
}

/**
 * Tiles present in OPFS, newest import first.
 *
 * Driven by what is **actually on disk**, with the manifest consulted only for import dates.
 * The obvious alternative — trusting the manifest alone — hides any tile written by something
 * other than an import, which is exactly the state a device left in by an earlier build ends
 * up in: the file is there and routes fine, but the UI swears nothing is installed. Listing
 * the directory means what is shown is what the router can actually see.
 */
export async function installedTiles(): Promise<InstalledTile[]> {
  const manifest = await readManifest()
  const names = await listDirectoryEntries(SEGMENT_DIR)

  const tiles: InstalledTile[] = []
  for (const name of names) {
    const match = /^([EW]\d{1,3}_[NS]\d{1,2})\.rd5$/.exec(name)
    if (!match) continue // .imported.json and anything else that is not a tile
    const tile = match[1]
    const path = `${SEGMENT_DIR}/${name}`

    // An interrupted download leaves a file here short of what it was ever meant to be.
    // Skipping it — never opening it, so it never registers with the VFS bridge — is what
    // keeps BRouter from seeing a present-but-corrupt segment instead of an honest absence.
    if (await isTruncated(path)) continue

    const handle = await openHandle(path)
    tiles.push({ tile, bytes: handle.getSize(), importedAt: manifest[tile]?.importedAt ?? null })
  }

  return tiles.sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0))
}

/**
 * Removes every tile from OPFS, whether or not the manifest knows about it.
 *
 * The recovery path when storage is in a state the UI cannot otherwise express — and the way
 * to start a device test from genuinely nothing.
 *
 * @returns the tiles removed
 */
export async function resetTileStorage(): Promise<string[]> {
  const names = await listDirectoryEntries(SEGMENT_DIR)
  const removed: string[] = []
  for (const name of names) {
    const path = `${SEGMENT_DIR}/${name}`
    await removeFile(path)
    await clearDownloading(path)
    const match = /^([EW]\d{1,3}_[NS]\d{1,2})\.rd5$/.exec(name)
    if (match) removed.push(match[1])
  }
  await writeManifest({})
  return removed
}
