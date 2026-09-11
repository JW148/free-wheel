import { beforeEach, describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import { downloadPlan, regionState } from '../data/regions'
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
const { readRecords, writeRecords } = await import('./regionRecords')
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

/**
 * The records in `/regions.json` are claims about files, and deleting a file that a claim
 * names has to retract the claim — otherwise the phone believes it has road data it does not
 * have, which is the one state the picker offers no way out of. Asserted through
 * `regionState` and `downloadPlan` rather than by reading the record, because those two are
 * what the screens actually ask.
 */
describe('a delete against the region records', () => {
  const manifest: DataManifest = {
    version: 1,
    generated: '2026-09-11T04:00:00Z',
    picker: { url: 'basemap/uk-z10-aaaa.pmtiles', bytes: 60959264 },
    segments: {
      W5_N50: { url: 'segments4/W5_N50-seg.rd5', bytes: 137527412, hash: 'seg', changed: '2026-09-01' },
    },
    regions: [],
  }
  const wessex: RegionEntry = {
    id: 'wessex',
    name: 'Wessex and the South Coast',
    bbox: [-2.6, 50.5, -0.7, 52.1],
    basemap: { url: 'regions/wessex-map.pmtiles', bytes: 90000000, hash: 'map', built: '2026-09-01' },
    segments: ['W5_N50'],
  }
  // Two regions sharing W5_N50, which is the case that made the stale claim invisible: the
  // plan skips a segment as soon as *any* record claims it, so one leftover record is enough
  // to keep every region from re-fetching the file that is actually gone.
  const installed: InstalledRegion[] = [
    { id: 'wessex', basemapHash: 'map', segmentHashes: { W5_N50: 'seg' }, installedAt: 1 },
    { id: 'south-west-england', basemapHash: 'sw', segmentHashes: { W5_N50: 'seg' }, installedAt: 2 },
  ]

  it('leaves both regions asking for the segment again, and nothing else', async () => {
    opfs.write(TILE_PATH, 137527412)
    await writeRecords(installed)

    await deleteTile('W5_N50')

    const records = await readRecords()
    expect(records.map((r) => r.segmentHashes)).toEqual([{}, {}])
    // The basemap claim is untouched: the .pmtiles is still on disk, and re-downloading 90 MB
    // because a segment went missing would be a lie in the other direction.
    expect(records.map((r) => r.basemapHash)).toEqual(['map', 'sw'])

    expect(regionState(wessex, records[0], true, manifest.segments)).toBe('road-data-outdated')
    const plan = downloadPlan(wessex, manifest, records)
    expect(plan.items.map((i) => i.key)).toEqual(['W5_N50'])
  })

  it('is what resetTileStorage does across the board', async () => {
    opfs.write(TILE_PATH, 137527412)
    await writeRecords(installed)

    await resetTileStorage()

    const records = await readRecords()
    expect(records.map((r) => r.segmentHashes)).toEqual([{}, {}])
    expect(regionState(wessex, records[0], true, manifest.segments)).toBe('road-data-outdated')
  })

  it('does not rewrite the records when no region claimed the tile', async () => {
    await writeRecords(installed)
    opfs.write(`${SEGMENT_DIR}/E10_N40.rd5`, 1000)

    await deleteTile('E10_N40')

    expect(await readRecords()).toEqual(installed)
  })
})

describe('readPartialHash', () => {
  it('reads a marker from a build that predates `started` as not started', async () => {
    // The shape the first version of this mechanism wrote. Left un-normalised, the type says
    // `started: boolean` while the value is `undefined`, and a reader that trusted the type
    // would resume onto bytes belonging to an older download.
    const handle = await openHandle('/downloads.json')
    const legacy = new TextEncoder().encode(
      JSON.stringify({ [TILE_PATH]: { hash: 'old-mirror-hash', bytes: 143654912 } }),
    )
    handle.truncate(0)
    handle.write(legacy, { at: 0 })
    handle.flush()
    refreshSize('/downloads.json')

    expect(await readPartialHash(TILE_PATH)).toEqual({
      hash: 'old-mirror-hash',
      bytes: 143654912,
      started: false,
    })
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
