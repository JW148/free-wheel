import { existsSync, openSync, readSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildPlaceIndex } from './buildIndex'
import { loadIndex, searchIndex } from './placeIndex'

/**
 * The scan, against a real archive.
 *
 * `data/basemap/edinburgh.pmtiles` is 34 MB and gitignored — it is cut by hand with the
 * `pmtiles extract` command in `CLAUDE.md` — so this skips where it is absent rather than
 * failing. It is here anyway because everything else about the index is tested against made-up
 * entries, and the one part that cannot be is whether Protomaps' tiles actually contain what
 * this believes they contain. When it runs, it is the only check that the decoding, the
 * projection back to lon/lat and the clustering all agree with the real world.
 */
const ARCHIVE = fileURLToPath(new URL('../../../data/basemap/edinburgh.pmtiles', import.meta.url))
const present = existsSync(ARCHIVE)

/** The sync range read the engine Worker does against an open OPFS handle, in plain Node. */
function reader(path: string) {
  const fd = openSync(path, 'r')
  return (_: string, offset: number, length: number) => {
    const buffer = new Uint8Array(length)
    readSync(fd, buffer, 0, length, offset)
    return buffer.buffer as ArrayBuffer
  }
}

describe.skipIf(!present)('buildPlaceIndex, against the Edinburgh extract', () => {
  it('finds the names the map has been drawing all along', { timeout: 60_000 }, async () => {
    const index = await buildPlaceIndex(ARCHIVE, 'edinburgh.pmtiles', 1, reader(ARCHIVE))
    const loaded = loadIndex(index)

    // 34,927 when this was written. A floor rather than an equality: the archive is re-cut from
    // a dated Protomaps build and the exact count moves with OpenStreetMap.
    expect(loaded.count).toBeGreaterThan(20_000)

    const near = { lon: -3.19, lat: 55.95 }
    const named = (query: string) => searchIndex(loaded, query, near).map((hit) => hit.name)

    expect(named('Portobello')[0]).toBe('Portobello')
    expect(named('Princes Street')[0]).toBe('Princes Street')
    expect(named('Arthur')).toContain("Arthur's Seat")
    expect(named('Water of Leith').length).toBeGreaterThan(0)
  })

  it('puts a well-known place within a few hundred metres of where it is', async () => {
    const index = await buildPlaceIndex(ARCHIVE, 'edinburgh.pmtiles', 1, reader(ARCHIVE))
    const hit = searchIndex(loadIndex(index), 'Portobello', { lon: -3.19, lat: 55.95 })[0]
    expect(hit.lon).toBeCloseTo(-3.11, 1)
    expect(hit.lat).toBeCloseTo(55.95, 1)
  })

  it('offers no railway lines to ride to', async () => {
    const index = await buildPlaceIndex(ARCHIVE, 'edinburgh.pmtiles', 1, reader(ARCHIVE))
    const loaded = loadIndex(index)
    for (const entry of loaded.source.kindTable) expect(entry).not.toBe('road:rail')
  })
})
