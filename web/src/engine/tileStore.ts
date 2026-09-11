import { listDirectoryEntries, openHandle, refreshSize, removeFile } from './opfsVfs'
import { isTruncated } from './partials'

/**
 * Tile storage — **import only**.
 *
 * The app deliberately does not download routing data. The user fetches `.rd5` segments from
 * brouter.de themselves and imports them here. That keeps the app free of any tile-hosting
 * dependency, and free of the CORS problem entirely: brouter.de serves no
 * `Access-Control-Allow-Origin` header, so a browser could never fetch from it directly, but a
 * file the user already has involves no cross-origin request at all.
 *
 * ## The trade-off, stated plainly
 *
 * brouter.de rebuilds segments **weekly** from current OpenStreetMap data. Imported files are
 * a snapshot and **do not update themselves** — they will drift out of date until the user
 * re-imports. Roads that changed, were added, or were removed since the import will not be
 * reflected in routing.
 *
 * The app cannot fix this, but it can refuse to hide it: {@link installedTiles} reports when
 * each tile was imported, and the tile catalogue records when brouter.de last rebuilt it, so
 * the UI can show the gap rather than leaving the user to guess.
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
  onProgress?.({ tile: file.name, received: offset, total: offset, state: 'complete' })
  return file.name
}

/** Basemap archives currently in OPFS. */
export async function installedBasemaps(): Promise<{ name: string; bytes: number }[]> {
  const names = await listDirectoryEntries(BASEMAP_DIR)
  const result: { name: string; bytes: number }[] = []
  for (const name of names) {
    if (!/\.pmtiles$/i.test(name)) continue
    const handle = await openHandle(`${BASEMAP_DIR}/${name}`)
    result.push({ name, bytes: handle.getSize() })
  }
  return result
}

/** Removes a tile from OPFS and forgets it. */
export async function deleteTile(tile: string): Promise<void> {
  await removeFile(`${SEGMENT_DIR}/${tile}.rd5`)
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
    await removeFile(`${SEGMENT_DIR}/${name}`)
    const match = /^([EW]\d{1,3}_[NS]\d{1,2})\.rd5$/.exec(name)
    if (match) removed.push(match[1])
  }
  await writeManifest({})
  return removed
}
