import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadManifest, parseManifest } from './manifest'

// The brief's suggested fix for a missing `localStorage` is a vitest environment pragma
// naming the jsdom package, but that package is not installed here (only a vitest
// peerDependency, unresolvable), and installing it is a decision for the controller, not this
// task. This is a minimal same-behaviour stand-in — get/set/clear backed by a Map — good
// enough for what these tests actually exercise.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

const good = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N55: { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 27262976, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' },
  },
  regions: [
    {
      id: 'central-scotland',
      name: 'Central Scotland',
      bbox: [-5.0, 55.4, -2.4, 56.4],
      basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 86384407, hash: '1c9d4e77', built: '2026-09-08' },
      segments: ['W5_N55'],
    },
  ],
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest and returns it typed', () => {
    const manifest = parseManifest(structuredClone(good))
    expect(manifest.regions[0].name).toBe('Central Scotland')
    expect(manifest.segments.W5_N55.hash).toBe('aaaa1111')
  })

  it('rejects a version it does not understand rather than half-reading it', () => {
    expect(() => parseManifest({ ...structuredClone(good), version: 2 })).toThrow(/version 2/)
  })

  it('rejects a region that needs a segment the manifest does not describe', () => {
    const broken = structuredClone(good)
    broken.regions[0].segments = ['W5_N55', 'W0_N55']
    expect(() => parseManifest(broken)).toThrow(/W0_N55/)
  })

  it('rejects a zero-byte asset, which means a failed upload', () => {
    const broken = structuredClone(good)
    broken.regions[0].basemap.bytes = 0
    expect(() => parseManifest(broken)).toThrow(/central-scotland/)
  })

  it('rejects anything that is not an object at all', () => {
    expect(() => parseManifest('<!doctype html>')).toThrow(/not a manifest/)
  })
})

describe('loadManifest', () => {
  beforeEach(() => localStorage.clear())

  it('fetches, caches, and reports the copy as fresh', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(good), { status: 200 }))
    const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.fresh).toBe(true)
    expect(result.manifest.regions[0].id).toBe('central-scotland')
    expect(localStorage.getItem('free-wheel.manifest')).toContain('central-scotland')
  })

  it('falls back to the cache when the network is gone, and says the copy is not fresh', async () => {
    localStorage.setItem('free-wheel.manifest', JSON.stringify(good))
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.fresh).toBe(false)
    expect(result.manifest.regions[0].id).toBe('central-scotland')
  })

  it('throws when it is offline and has never cached anything', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    await expect(loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/no saved copy/)
  })

  it('keeps the cached copy when the server answers with something unparseable', async () => {
    localStorage.setItem('free-wheel.manifest', JSON.stringify(good))
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', { status: 200 }))
    const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.fresh).toBe(false)
    expect(result.manifest.regions[0].id).toBe('central-scotland')
  })
})
