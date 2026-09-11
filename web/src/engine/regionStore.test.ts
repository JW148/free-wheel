import { describe, expect, it, vi } from 'vitest'
import type { DataManifest, InstalledRegion } from '../data/manifest'
import type { DownloadItem } from '../data/regions'
import type { ByteSink, RegionProgress } from './downloads'
import type { PartialTarget } from './partials'
import {
  basemapFileFor,
  pathForItem,
  recordAfterDownload,
  recordsAfterRemoval,
  runRegionDownload,
  serializeRegionOp,
  type DownloadLoopDeps,
} from './regionStore'

const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
  },
  regions: [
    { id: 'wessex', name: 'Wessex and the South Coast', bbox: [-2.6, 50.5, -0.7, 51.6],
      basemap: { url: 'regions/wessex-1111aaaa.pmtiles', bytes: 90000000, hash: '1111aaaa', built: '2026-09-08' },
      segments: ['W5_N50'] },
    { id: 'south-west-england', name: 'South West England', bbox: [-5.8, 49.9, -2.4, 51.5],
      basemap: { url: 'regions/south-west-england-2222bbbb.pmtiles', bytes: 70000000, hash: '2222bbbb', built: '2026-09-08' },
      segments: ['W5_N50'] },
  ],
}

const wessex: InstalledRegion = {
  id: 'wessex', basemapHash: '1111aaaa', segmentHashes: { W5_N50: 'bbbb2222' }, installedAt: 1,
}

describe('serializeRegionOp', () => {
  it('runs overlapping calls one at a time, in the order they were queued', async () => {
    const order: string[] = []

    const first = serializeRegionOp(async () => {
      order.push('first-start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('first-end')
      return 'first'
    })

    // Queued while `first` is still running — this overlap, left unserialized, is exactly what
    // let two downloadRegion calls each compute `records` from the same stale snapshot.
    const second = serializeRegionOp(async () => {
      order.push('second-start')
      return 'second'
    })

    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  it('does not let one call\'s failure wedge the ones queued after it', async () => {
    const failing = serializeRegionOp(async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')

    const after = serializeRegionOp(async () => 'still runs')
    await expect(after).resolves.toBe('still runs')
  })
})

describe('recordAfterDownload', () => {
  it('adds a region with the hashes it was downloaded at', () => {
    const records = recordAfterDownload([], manifest.regions[0], manifest, 1)
    expect(records).toEqual([wessex])
  })

  it('replaces an earlier record for the same region rather than duplicating it', () => {
    const stale = { ...wessex, basemapHash: 'old', installedAt: 0 }
    const records = recordAfterDownload([stale], manifest.regions[0], manifest, 2)
    expect(records).toHaveLength(1)
    expect(records[0].basemapHash).toBe('1111aaaa')
    expect(records[0].installedAt).toBe(2)
  })

  it('throws a named error when the manifest does not describe one of the region\'s segments', () => {
    const brokenManifest: DataManifest = { ...manifest, segments: {} }
    expect(() => recordAfterDownload([], manifest.regions[0], brokenManifest, 1))
      .toThrow('wessex needs segment W5_N50, which the manifest does not describe')
  })
})

describe('recordsAfterRemoval', () => {
  it('deletes the segment when no other region needs it', () => {
    const result = recordsAfterRemoval([wessex], 'wessex')
    expect(result.records).toEqual([])
    expect(result.deleteSegments).toEqual(['W5_N50'])
    expect(result.deleteBasemap).toBe('wessex.pmtiles')
  })

  it('keeps a shared segment that another installed region still routes on', () => {
    const southWest = recordAfterDownload([wessex], manifest.regions[1], manifest, 3)
    const result = recordsAfterRemoval(southWest, 'wessex')
    expect(result.records.map((r) => r.id)).toEqual(['south-west-england'])
    expect(result.deleteSegments).toEqual([])
  })

  it('is a no-op for a region that is not installed', () => {
    const result = recordsAfterRemoval([wessex], 'kent-sussex')
    expect(result.records).toEqual([wessex])
    expect(result.deleteSegments).toEqual([])
  })
})

// --- runRegionDownload -------------------------------------------------------------------

function fakeSink(initial = new Uint8Array(0)): ByteSink & { readonly bytes: Uint8Array } {
  let bytes = initial
  return {
    size: () => bytes.length,
    truncate: (to) => {
      bytes = bytes.slice(0, to)
    },
    write: (chunk, at) => {
      if (at + chunk.length > bytes.length) {
        const grown = new Uint8Array(at + chunk.length)
        grown.set(bytes)
        bytes = grown
      }
      bytes.set(chunk, at)
    },
    flush: () => {},
    get bytes() {
      return bytes
    },
  }
}

const text = (s: string) => new TextEncoder().encode(s)
const decode = (sink: ByteSink & { bytes: Uint8Array }) => new TextDecoder().decode(sink.bytes)

/**
 * A stand-in for OPFS plus the partial-hash store, shared across two calls to
 * `runRegionDownload` within one test to model a retry seeing what the first attempt left
 * behind — the whole point of the persistence guarantees under test.
 */
function fakeDownloadEnv() {
  const sinks = new Map<string, ByteSink & { bytes: Uint8Array }>()
  const partials = new Map<string, PartialTarget>()
  const recorded: { name: string; bytes: number }[] = []

  const deps: DownloadLoopDeps = {
    openSink: async (path) => {
      if (!sinks.has(path)) sinks.set(path, fakeSink())
      return sinks.get(path)!
    },
    refreshSize: () => {},
    readPartialHash: async (path) => partials.get(path) ?? null,
    writePartialHash: async (path, target) => {
      partials.set(path, target)
    },
    recordSegmentWritten: async (name, bytes) => {
      recorded.push({ name, bytes })
    },
  }

  return { sinks, partials, recorded, deps }
}

describe('runRegionDownload', () => {
  it('downloads every item of a clean multi-item region', async () => {
    const items: DownloadItem[] = [
      { kind: 'basemap', key: 'wessex', url: 'https://example/basemap.pmtiles', bytes: 10, hash: 'hb' },
      { kind: 'segment', key: 'W5_N50', url: 'https://example/W5_N50.rd5', bytes: 6, hash: 'hs' },
    ]
    const { sinks, recorded, deps } = fakeDownloadEnv()
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('basemap')
        ? new Response(text('0123456789'), { status: 200 })
        : new Response(text('abcdef'), { status: 200 }),
    )
    const progress: RegionProgress[] = []

    await runRegionDownload(
      'wessex',
      items,
      16,
      { ...deps, fetchImpl: fetchImpl as unknown as typeof fetch },
      (p) => progress.push(p),
    )

    expect(decode(sinks.get(pathForItem('wessex', items[0]))!)).toBe('0123456789')
    expect(decode(sinks.get(pathForItem('wessex', items[1]))!)).toBe('abcdef')
    expect(recorded).toEqual([{ name: 'W5_N50', bytes: 6 }])
    expect(progress.filter((p) => p.state === 'complete')).toHaveLength(2)
    expect(progress.at(-1)).toMatchObject({ overallReceived: 16, overallTotal: 16 })
  })

  it('skips an item whose bytes and hash already match, without touching the network', async () => {
    const item: DownloadItem = { kind: 'segment', key: 'W5_N50', url: 'https://example/W5_N50.rd5', bytes: 6, hash: 'hs' }
    const path = pathForItem('wessex', item)
    const { sinks, partials, recorded, deps } = fakeDownloadEnv()
    sinks.set(path, fakeSink(text('abcdef')))
    partials.set(path, { hash: 'hs', bytes: 6 })
    const fetchImpl = vi.fn()

    await runRegionDownload('wessex', [item], 6, { ...deps, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(decode(sinks.get(path)!)).toBe('abcdef')
    expect(recorded).toEqual([]) // never (re)written, so its age must not be touched
  })

  it('resumes rather than restarts after a mid-region failure, without re-fetching a completed item', async () => {
    const segmentA: DownloadItem = { kind: 'segment', key: 'A1_N1', url: 'https://example/a.rd5', bytes: 4, hash: 'ha' }
    const segmentB: DownloadItem = { kind: 'segment', key: 'B1_N1', url: 'https://example/b.rd5', bytes: 10, hash: 'hb' }
    const items = [segmentA, segmentB]
    const { sinks, partials, deps } = fakeDownloadEnv()
    const pathA = pathForItem('region', segmentA)
    const pathB = pathForItem('region', segmentB)

    let pulls = 0
    const droppedFetch = vi.fn(async (url: string) => {
      if (url.includes('/a.rd5')) return new Response(text('abcd'), { status: 200 })
      // `pull` rather than `start`: erroring a stream discards its already-enqueued chunk per
      // spec, so a chunk delivered via a successful `pull` before the next one errors is what
      // an actual dropped connection looks like — some bytes already handed to the reader.
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            if (pulls === 1) controller.enqueue(text('efgh'))
            else controller.error(new Error('connection dropped'))
          },
        }),
        { status: 200 },
      )
    })

    await expect(
      runRegionDownload('region', items, 14, { ...deps, fetchImpl: droppedFetch as unknown as typeof fetch }),
    ).rejects.toThrow('connection dropped')

    // Segment A finished; segment B has exactly what was flushed before the drop. Both
    // partial-hash entries are still there — `runRegionDownload` never clears them; that is
    // the caller's job once the whole region is recorded, which never happened here.
    expect(decode(sinks.get(pathA)!)).toBe('abcd')
    expect(decode(sinks.get(pathB)!)).toBe('efgh')
    expect(partials.get(pathA)).toEqual({ hash: 'ha', bytes: 4 })
    expect(partials.get(pathB)).toEqual({ hash: 'hb', bytes: 10 })

    const resumedFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: 'bytes=4-' })
      return new Response(text('ijklmn'), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' } })
    })

    await runRegionDownload('region', items, 14, { ...deps, fetchImpl: resumedFetch as unknown as typeof fetch })

    // Only segment B was fetched — segment A's decision came back `done` and was skipped.
    expect(resumedFetch).toHaveBeenCalledTimes(1)
    expect(resumedFetch.mock.calls[0][0]).toBe(segmentB.url)
    expect(decode(sinks.get(pathB)!)).toBe('efghijklmn')
  })
})
