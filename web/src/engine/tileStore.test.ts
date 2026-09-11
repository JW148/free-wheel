import { beforeEach, describe, expect, it } from 'vitest'
import { installFakeOpfs } from './fakeOpfs'

/**
 * Tile and basemap storage against a fake OPFS — the real `opfsVfs.ts`, `partials.ts` and
 * `tileStore.ts` all run.
 *
 * The subject is the lifetime of the two download markers. A file is hidden from BRouter while
 * a durable `/downloads.json` entry or an in-memory `targetSize` says it is short of what it is
 * being written toward, and every bug this mechanism has produced has been one of those markers
 * outliving the thing it described. So each test here names what makes the file visible again
 * and then asks the bridge, rather than asserting a flag.
 *
 * An earlier version of this file mocked `./opfsVfs` wholesale, which made the in-memory half
 * of the marker untestable — its `markPending` stub was annotated "Not exercised here" — and
 * that is precisely the half that then broke.
 */
const opfs = installFakeOpfs()

const {
  deleteTile,
  importBasemapFile,
  importTileFile,
  installedBasemaps,
  installedTiles,
  resetTileStorage,
  BASEMAP_DIR,
  SEGMENT_DIR,
} = await import('./tileStore')
const { clearDownloading, markDownloading, readPartialHash } = await import('./partials')
const { closeOpfs, installVfsBridge, openHandle, refreshSize } = await import('./opfsVfs')

const TILE_PATH = `${SEGMENT_DIR}/W5_N50.rd5`
const BASEMAP_PATH = `${BASEMAP_DIR}/wessex.pmtiles`

interface Bridge {
  exists(path: string): boolean
  isFile(path: string): boolean
  size(path: string): number
}

function bridge(): Bridge {
  installVfsBridge()
  return (globalThis as unknown as { freeWheelVfs: Bridge }).freeWheelVfs
}

const segmentFile = (bytes: number) => new File([new Uint8Array(bytes).fill(7)], 'W5_N50.rd5')
const basemapFile = (bytes: number) => new File([new Uint8Array(bytes).fill(7)], 'wessex.pmtiles')

/**
 * A region download that started writing this path and then died — both markers set, part of
 * the file on disk, exactly the state `runRegionDownload` leaves behind on a dropped
 * connection. The target is the mirror's byte count, which is not what the file holds.
 */
async function abandonedDownload(path: string, wrote: number, target: number): Promise<void> {
  const handle = await openHandle(path)
  handle.truncate(0)
  handle.write(new Uint8Array(wrote).fill(1), { at: 0 })
  handle.flush()
  refreshSize(path)
  await markDownloading(path, { hash: 'old-mirror-hash', bytes: target, started: true })
}

beforeEach(() => {
  closeOpfs()
  opfs.reset()
})

describe('a truncated download', () => {
  it('is hidden from the tile listing and never opened, after a restart', async () => {
    // Only the durable marker survives a Worker restart, so this is the state a fresh session
    // finds: an orphan file and a `/downloads.json` entry naming a size it never reached.
    opfs.write(TILE_PATH, 100)
    await markDownloading(TILE_PATH, { hash: 'mirror', bytes: 143654912, started: true })

    expect(await installedTiles()).toEqual([])
    // Never opened is the point: opening is what registers a path with the bridge, and a
    // half-written .rd5 that BRouter can see reads as corrupt data rather than as no data.
    expect(bridge().exists(TILE_PATH)).toBe(false)
  })

  it('is hidden from the basemap listing too', async () => {
    opfs.write(BASEMAP_PATH, 100)
    await markDownloading(BASEMAP_PATH, { hash: 'mirror', bytes: 90000000, started: true })

    expect(await installedBasemaps()).toEqual([])
  })
})

describe('importTileFile', () => {
  it('makes a hand import the last word over the markers an abandoned download left', async () => {
    // brouter.de rebuilds weekly, so an import is essentially never the byte count some earlier
    // mirror snapshot recorded — here smaller, which is the coin-flip half that used to hide a
    // complete, correct file until the Worker restarted.
    await abandonedDownload(TILE_PATH, 500, 143654912)
    expect(bridge().exists(TILE_PATH)).toBe(false)

    await importTileFile(segmentFile(2000))

    expect(await readPartialHash(TILE_PATH)).toBeNull()
    expect((await installedTiles()).map((t) => t.tile)).toContain('W5_N50')
    // The half that fix 1 was about: the UI listing it is not enough if BRouter cannot see it.
    expect(bridge().exists(TILE_PATH)).toBe(true)
    expect(bridge().isFile(TILE_PATH)).toBe(true)
    expect(bridge().size(TILE_PATH)).toBe(2000)
  })

  it('leaves no marker behind when it replaces a file nothing was downloading', async () => {
    await importTileFile(segmentFile(2000))
    expect(await readPartialHash(TILE_PATH)).toBeNull()
    expect(bridge().size(TILE_PATH)).toBe(2000)
  })
})

describe('importBasemapFile', () => {
  it('makes a hand import the last word over the markers an abandoned download left', async () => {
    await abandonedDownload(BASEMAP_PATH, 500, 90000000)

    await importBasemapFile(basemapFile(2000))

    expect(await readPartialHash(BASEMAP_PATH)).toBeNull()
    expect((await installedBasemaps()).map((b) => b.name)).toContain('wessex.pmtiles')
    expect(bridge().size(BASEMAP_PATH)).toBe(2000)
  })
})

describe('deleteTile', () => {
  it('takes both markers with the file, so the path can be used again', async () => {
    await abandonedDownload(TILE_PATH, 500, 143654912)

    await deleteTile('W5_N50')

    expect(await readPartialHash(TILE_PATH)).toBeNull()
    expect(opfs.read(TILE_PATH)).toBeNull()

    // Re-importing at the same path must not inherit anything from the deleted file.
    await importTileFile(segmentFile(2000))
    expect(bridge().size(TILE_PATH)).toBe(2000)
    expect((await installedTiles()).map((t) => t.tile)).toEqual(['W5_N50'])
  })
})

describe('resetTileStorage', () => {
  it('clears the markers of every tile it removes', async () => {
    await abandonedDownload(TILE_PATH, 500, 143654912)
    const other = `${SEGMENT_DIR}/E10_N40.rd5`
    await abandonedDownload(other, 700, 120000000)

    await resetTileStorage()

    expect(await readPartialHash(TILE_PATH)).toBeNull()
    expect(await readPartialHash(other)).toBeNull()

    await importTileFile(segmentFile(2000))
    expect((await installedTiles()).map((t) => t.tile)).toEqual(['W5_N50'])
    expect(bridge().exists(TILE_PATH)).toBe(true)
  })
})

describe('clearDownloading', () => {
  it('is enough on its own to bring a marked file back, in both halves', async () => {
    // The invariant the two halves share: whatever set them, this is what unsets them, and it
    // has to move both or the session and the restart disagree about whether the file is there.
    await abandonedDownload(TILE_PATH, 500, 143654912)

    await clearDownloading(TILE_PATH)

    expect(await readPartialHash(TILE_PATH)).toBeNull()
    expect(bridge().exists(TILE_PATH)).toBe(true)
    expect(bridge().size(TILE_PATH)).toBe(500)
  })
})
