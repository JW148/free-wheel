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

  it('rejects a region with no segments, which would price as a map with no road data', () => {
    // The shape the mirror publishes while bootstrapping: `buildBootstrapManifest` carries a
    // region whose segments are not mirrored yet forward with an empty list, so that
    // `cut-basemaps` can publish on an empty bucket at all. Downloaded, it would install a
    // basemap, record itself, and read `current` with nothing for BRouter to route on.
    const broken = structuredClone(good)
    broken.regions[0].segments = []
    expect(() => parseManifest(broken)).toThrow(/central-scotland: has no segments/)
  })

  it('rejects a zero-byte asset, which means a failed upload', () => {
    const broken = structuredClone(good)
    broken.regions[0].basemap.bytes = 0
    expect(() => parseManifest(broken)).toThrow(/central-scotland/)
  })

  it('rejects anything that is not an object at all', () => {
    expect(() => parseManifest('<!doctype html>')).toThrow(/not a manifest/)
  })

  it('rejects a zero-byte picker, which the region basemap check already covers but the picker skipped', () => {
    const broken = structuredClone(good)
    broken.picker.bytes = 0
    expect(() => parseManifest(broken)).toThrow(/picker/)
  })

  it('rejects non-finite bytes, not just zero or negative', () => {
    const broken = structuredClone(good)
    ;(broken.segments.W5_N55 as { bytes: number }).bytes = Number.POSITIVE_INFINITY
    expect(() => parseManifest(broken)).toThrow(/W5_N55/)
  })

  it('rejects a segment key that is not a grid cell id, closing a prototype-pollution corner', () => {
    // Built via JSON.parse rather than a literal `{ __proto__: ... }`, so the result has a
    // real own property named "__proto__" (JSON.parse's own-property semantics), not the
    // prototype of the object itself — the same shape a malicious or corrupt manifest.json
    // payload would take once parsed.
    const raw = JSON.parse(JSON.stringify(good).replace(/W5_N55/g, '__proto__'))
    expect(() => parseManifest(raw)).toThrow(/__proto__/)
  })

  it('rejects a region id that is not a plain slug, because the id becomes a file path', () => {
    // `regionStore.basemapFileFor` turns an id straight into an OPFS path, so an id carrying a
    // separator writes a region's basemap into some other directory. `opfsVfs.normalise`
    // resolves `..` inside the OPFS root, so nothing escapes origin storage — this is a
    // data-authoring mistake rather than an attack — but the wrong directory is still wrong,
    // and the parser is where every other shape is already checked.
    for (const id of ['../segments4/W5_N55', 'kent/sussex', 'Kent-Sussex', 'kent sussex', '']) {
      const raw = JSON.parse(JSON.stringify(good))
      raw.regions[0].id = id
      expect(() => parseManifest(raw)).toThrow(/region id/)
    }
  })

  it('names the id it rejected, so a manifest build can be fixed without guessing', () => {
    const raw = JSON.parse(JSON.stringify(good))
    raw.regions[0].id = 'kent/sussex'
    expect(() => parseManifest(raw)).toThrow('kent/sussex')
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

  it('discards a corrupt cached copy rather than failing the same way forever', async () => {
    localStorage.setItem('free-wheel.manifest', 'not json at all')
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    await expect(loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/unreadable/)
    expect(localStorage.getItem('free-wheel.manifest')).toBeNull()
  })

  it('does not let a failed cache write demote a successful fetch to stale or failed', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(good), { status: 200 }))
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    try {
      const result = await loadManifest({ fetchImpl: fetchImpl as unknown as typeof fetch })
      expect(result.fresh).toBe(true)
      expect(result.manifest.regions[0].id).toBe('central-scotland')
    } finally {
      setItemSpy.mockRestore()
    }
  })
})
