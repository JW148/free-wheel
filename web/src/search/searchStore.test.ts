import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaceIndex } from './placeIndex'

/*
 * The store is a module singleton, so each test imports a fresh copy over fresh fakes: one for
 * IndexedDB (`placeStore`) and one for the engine Worker that builds an index.
 */
const stored = new Map<string, PlaceIndex>()
const buildPlaceIndex = vi.fn()

vi.mock('./placeStore', () => ({
  placesAvailable: () => true,
  readIndex: async (archive: string) => stored.get(archive),
  writeIndex: async (index: PlaceIndex) => {
    stored.set(index.archive, index)
    return index
  },
  dropIndex: async (archive: string) => {
    stored.delete(archive)
  },
  indexedArchives: async () => [...stored.keys()],
  indexIsCurrent: (index: PlaceIndex | undefined, bytes: number) =>
    index !== undefined && index.sourceBytes === bytes,
}))

vi.mock('../engine/engineClient', () => ({
  sharedEngine: () => ({ buildPlaceIndex }),
}))

const indexFor = (archive: string, sourceBytes: number): PlaceIndex => ({
  archive,
  builtAt: 0,
  sourceBytes,
  names: '',
  kindTable: [],
  kinds: new Uint16Array(0),
  lons: new Float32Array(0),
  lats: new Float32Array(0),
})

const fresh = async () => {
  vi.resetModules()
  return (await import('./searchStore')).places
}

beforeEach(() => {
  stored.clear()
  buildPlaceIndex.mockReset()
  buildPlaceIndex.mockImplementation(async (name: string) => indexFor(name, 1))
})

describe('places.sync', () => {
  /*
   * The launch path. The map has not read storage yet, so it does not know what is installed —
   * and "unknown" handed over as an empty list read as "every region was deleted", which threw
   * every stored index away and rebuilt them all in the Worker that serves the map's tiles.
   */
  it('keeps every stored index while what is installed is still unknown', async () => {
    stored.set('edinburgh.pmtiles', indexFor('edinburgh.pmtiles', 100))
    stored.set('london.pmtiles', indexFor('london.pmtiles', 200))
    const places = await fresh()

    await places.sync(null)
    await places.sync([
      { name: 'edinburgh.pmtiles', bytes: 100 },
      { name: 'london.pmtiles', bytes: 200 },
    ])

    expect(buildPlaceIndex).not.toHaveBeenCalled()
    expect(places.snapshot().ready.sort()).toEqual(['edinburgh.pmtiles', 'london.pmtiles'])
    expect([...stored.keys()].sort()).toEqual(['edinburgh.pmtiles', 'london.pmtiles'])
  })

  it('still drops the index of a region that is really gone', async () => {
    stored.set('edinburgh.pmtiles', indexFor('edinburgh.pmtiles', 100))
    const places = await fresh()

    await places.sync([])

    expect([...stored.keys()]).toEqual([])
  })

  it('builds only the archive that has no current index', async () => {
    stored.set('edinburgh.pmtiles', indexFor('edinburgh.pmtiles', 100))
    const places = await fresh()

    await places.sync([
      { name: 'edinburgh.pmtiles', bytes: 100 },
      { name: 'london.pmtiles', bytes: 200 },
    ])

    expect(buildPlaceIndex).toHaveBeenCalledTimes(1)
    expect(buildPlaceIndex.mock.calls[0][0]).toBe('london.pmtiles')
  })
})
