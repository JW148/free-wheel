import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A minimal in-memory stand-in for the pieces of `opfsVfs.ts` that `tileStore.ts` and its
 * `partials.ts` dependency use, at the same seam `regionStore.test.ts` fakes `ByteSink` and
 * `fetch` through — one level lower, because `tileStore.ts` has no injected-dependency seam of
 * its own. Not a reimplementation of OPFS: no directories, no locking, just enough of
 * `openHandle`/`removeFile`/`listDirectoryEntries`/`peekFileSize`/`refreshSize` for the real
 * `tileStore.ts` and `partials.ts` logic to run against, so what is under test is that logic —
 * the interaction between an import and a stale partial-hash entry — not a browser API.
 */
vi.mock('./opfsVfs', () => {
  const store = new Map<string, Uint8Array>()

  function read(path: string) {
    return store.get(path) ?? new Uint8Array(0)
  }

  function makeHandle(path: string) {
    return {
      getSize: () => read(path).length,
      truncate: (size: number) => {
        store.set(path, read(path).slice(0, size))
      },
      write: (buf: Uint8Array, { at }: { at: number }) => {
        const cur = read(path)
        const needed = at + buf.length
        const next = needed > cur.length ? new Uint8Array(needed) : cur.slice()
        if (needed > cur.length) next.set(cur)
        next.set(buf, at)
        store.set(path, next)
        return buf.length
      },
      read: (buf: Uint8Array, { at }: { at: number }) => {
        const cur = read(path)
        const n = Math.max(0, Math.min(buf.length, cur.length - at))
        if (n > 0) buf.set(cur.subarray(at, at + n))
        return n
      },
      flush: () => {},
      close: () => {},
    }
  }

  return {
    openHandle: vi.fn(async (path: string) => makeHandle(path)),
    refreshSize: vi.fn(() => -1),
    removeFile: vi.fn(async (path: string) => {
      store.delete(path)
    }),
    listDirectoryEntries: vi.fn(async (dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.add(key.slice(prefix.length))
        }
      }
      return [...names].sort()
    }),
    peekFileSize: vi.fn(async (path: string) => (store.has(path) ? read(path).length : -1)),
    // Not exercised here — installedTiles()/installedBasemaps() only ever call it before
    // opening a file, and this fake's "openHandle" has no registry to keep in sync with.
    markPending: vi.fn(),
    __store: store,
  }
})

const { importTileFile, installedTiles, SEGMENT_DIR, importBasemapFile, installedBasemaps, BASEMAP_DIR } =
  await import('./tileStore')
const { writePartialHash, readPartialHash } = await import('./partials')

beforeEach(async () => {
  const mod = (await import('./opfsVfs')) as unknown as { __store: Map<string, Uint8Array> }
  mod.__store.clear()
})

describe('importTileFile clears a stale partial-hash entry', () => {
  it('lets a hand import replace the target an abandoned download attempt left behind', async () => {
    const path = `${SEGMENT_DIR}/W5_N50.rd5`

    // A region download of this exact segment started, recorded the mirror snapshot's target
    // byte count, and then never finished — the entry outlives the failed attempt by design
    // (see regionStore.runRegionDownload's doc comment), and nothing else has cleared it.
    await writePartialHash(path, { hash: 'old-mirror-hash', bytes: 143654912 })

    // The rider gives up and imports a real file by hand instead. brouter.de rebuilds weekly,
    // so this is essentially never the same byte count as the abandoned mirror snapshot — here,
    // deliberately much smaller, which is what used to make `isTruncated` say true forever.
    const bytes = new Uint8Array(2000).fill(7)
    const file = new File([bytes], 'W5_N50.rd5')

    await importTileFile(file)

    expect(await readPartialHash(path)).toBeNull()
    const tiles = await installedTiles()
    expect(tiles.map((t) => t.tile)).toContain('W5_N50')
  })
})

describe('importBasemapFile clears a stale partial-hash entry', () => {
  it('lets a hand import replace the target a died-mid-basemap region download left behind', async () => {
    const path = `${BASEMAP_DIR}/wessex.pmtiles`

    // A region download died partway through this exact basemap, recording the mirror
    // snapshot's target byte count — the entry outlives the failed attempt by design, and
    // nothing else has cleared it.
    await writePartialHash(path, { hash: 'old-mirror-hash', bytes: 90000000 })

    // The rider gives up and imports a complete archive by hand instead, at a name that
    // happens to collide with the region's own path. Deliberately a different size, which is
    // what used to make `isTruncated` say true forever — and now that `installedBasemaps()`
    // also consults `isTruncated`, this path is live rather than theoretical.
    const bytes = new Uint8Array(2000).fill(7)
    const file = new File([bytes], 'wessex.pmtiles')

    await importBasemapFile(file)

    expect(await readPartialHash(path)).toBeNull()
    const basemaps = await installedBasemaps()
    expect(basemaps.map((b) => b.name)).toContain('wessex.pmtiles')
  })
})
