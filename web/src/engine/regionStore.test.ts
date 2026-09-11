import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataManifest, InstalledRegion } from '../data/manifest'
import type { DownloadItem } from '../data/regions'
import type { ByteSink, RegionProgress } from './downloads'
import type { PartialTarget } from './partials'
import { installFakeOpfs } from './fakeOpfs'
import {
  completeRegionDownload,
  deleteRegionFiles,
  markDownloading,
  opfsDownloadDeps,
  pathForItem,
  readPartialHash,
  readRecords,
  recordAfterDownload,
  recordsAfterRemoval,
  runRegionDownload,
  serializeRegionOp,
  type DownloadLoopDeps,
} from './regionStore'
import { BASEMAP_DIR, installedTiles, SEGMENT_DIR } from './tileStore'
import { clearPending, closeOpfs, installVfsBridge } from './opfsVfs'

/**
 * Most of this file needs no storage — the record functions are pure and the download loop runs
 * on injected deps. `deleteRegionFiles` is the exception, so the fake OPFS from `fakeOpfs.ts`
 * backs the real `opfsVfs.ts` for those tests rather than mocking the module out.
 */
const opfs = installFakeOpfs()

beforeEach(() => {
  closeOpfs()
  opfs.reset()
})

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

function fakeSink(
  initial = new Uint8Array(0),
  log: string[] = [],
  name = '',
): ByteSink & { readonly bytes: Uint8Array } {
  let bytes = initial
  return {
    size: () => bytes.length,
    truncate: (to) => {
      log.push(`truncate:${name}`)
      bytes = bytes.slice(0, to)
    },
    write: (chunk, at) => {
      log.push(`write:${name}`)
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
  /** The durable `/downloads.json` half of the marker. */
  const partials = new Map<string, PartialTarget>()
  /** The in-memory `targetSize` half. Set and cleared together with the durable one. */
  const pending = new Map<string, number>()
  const recorded: { name: string; bytes: number }[] = []
  const refreshSizeCalls: string[] = []
  /** Marking and sink mutations in the order they happened — see the ordering test. */
  const log: string[] = []

  const deps: DownloadLoopDeps = {
    openSink: async (path) => {
      log.push(`open:${path}`)
      if (!sinks.has(path)) sinks.set(path, fakeSink(new Uint8Array(0), log, path))
      return sinks.get(path)!
    },
    // Sizes a file without the side effects of opening one — so an unopened path is -1, the
    // same answer `opfsVfs.peekFileSize` gives for a file that is not there.
    peekSize: async (path) => sinks.get(path)?.size() ?? -1,
    refreshSize: (path) => {
      refreshSizeCalls.push(path)
    },
    markDownloading: async (path, target) => {
      log.push(`mark:${target.started ? 'started' : 'claimed'}:${path}`)
      partials.set(path, target)
      pending.set(path, target.bytes)
    },
    readPartialHash: async (path) => partials.get(path) ?? null,
    recordSegmentWritten: async (name, bytes) => {
      recorded.push({ name, bytes })
    },
  }

  return { sinks, partials, recorded, pending, refreshSizeCalls, log, deps }
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
    partials.set(path, { hash: 'hs', bytes: 6, started: true })
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
    expect(partials.get(pathA)).toEqual({ hash: 'ha', bytes: 4, started: true })
    expect(partials.get(pathB)).toEqual({ hash: 'hb', bytes: 10, started: true })

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

  it('marks a file before it disturbs it, and in both halves at once', async () => {
    const item: DownloadItem = { kind: 'segment', key: 'W5_N50', url: 'https://example/w.rd5', bytes: 6, hash: 'hw' }
    const path = pathForItem('region', item)
    const { deps, log, partials, pending } = fakeDownloadEnv()
    const fetchImpl = vi.fn(async () => new Response(text('abcdef'), { status: 200 }))

    await runRegionDownload('region', [item], 6, { ...deps, fetchImpl: fetchImpl as unknown as typeof fetch })

    // The whole sequence, in order, because each step is only safe in this position:
    //
    //   claim -> open -> truncate -> start -> write
    //
    // The claim comes first because it is what hides the file, and it has to be in place from
    // the moment the file can change — including a failure of the open itself. The flip to
    // `started` comes after the truncate because that is the moment the file stops holding
    // anyone else's bytes: before it, a resume would append this download's tail to the last
    // one's prefix, and the length check would not notice.
    expect(log).toEqual([
      `mark:claimed:${path}`,
      `open:${path}`,
      `truncate:${path}`,
      `mark:started:${path}`,
      `truncate:${path}`,
      `write:${path}`,
    ])

    // Both halves, from one call: the durable entry a restart reads, and the registry marker
    // this session reads. Neither is allowed to be set without the other.
    expect(partials.get(path)).toEqual({ hash: 'hw', bytes: 6, started: true })
    expect(pending.get(path)).toBe(6)
  })

  it('marks nothing when the attempt dies before it touches the file', async () => {
    // The instant drop: no response, so the bytes on disk are untouched — and they may be a
    // complete, valid older segment the rider has been routing on for weeks. Marking here
    // would hide a file nobody touched, and the durable half of that marker outlives the
    // session, so it would keep hiding it until the segment was re-imported or deleted.
    const item: DownloadItem = { kind: 'segment', key: 'W5_N50', url: 'https://example/w.rd5', bytes: 10, hash: 'hw' }
    const path = pathForItem('region', item)
    const { deps, log, partials, pending, refreshSizeCalls, sinks } = fakeDownloadEnv()
    sinks.set(path, fakeSink(text('a complete older segment')))

    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })

    await expect(
      runRegionDownload('region', [item], 10, { ...deps, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('network down')

    expect(partials.has(path)).toBe(false)
    expect(pending.has(path)).toBe(false)
    // Not opened either — see the real-registry tests below for why that is the half that
    // matters, and what it costs when only the marking is deferred.
    expect(log).not.toContain(`open:${path}`)
    // Nothing was written, so there is nothing stale to re-measure either.
    expect(refreshSizeCalls).not.toContain(path)
    expect(decode(sinks.get(path)!)).toBe('a complete older segment')
  })

  it('marks, and re-measures, a file an attempt did start writing before it failed', async () => {
    const item: DownloadItem = { kind: 'segment', key: 'W5_N50', url: 'https://example/w.rd5', bytes: 10, hash: 'hw' }
    const path = pathForItem('region', item)
    const { deps, partials, pending, refreshSizeCalls } = fakeDownloadEnv()

    let pulls = 0
    const droppedFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1
              if (pulls === 1) controller.enqueue(text('efgh'))
              else controller.error(new Error('connection dropped'))
            },
          }),
          { status: 200 },
        ),
    )

    await expect(
      runRegionDownload('region', [item], 10, { ...deps, fetchImpl: droppedFetch as unknown as typeof fetch }),
    ).rejects.toThrow('connection dropped')

    // This file really is short now, and both markers say so — the durable one so a restart
    // keeps it out of `installedTiles()`, the registry one so the VFS bridge answers absent for
    // the rest of this session.
    expect(partials.get(path)).toEqual({ hash: 'hw', bytes: 10, started: true })
    expect(pending.get(path)).toBe(10)

    // And the cached size is brought back in line: a file that previously held a full,
    // different segment would otherwise keep answering with that old size, letting a read run
    // past what the truncated-and-partly-rewritten file actually contains.
    expect(refreshSizeCalls).toContain(path)
  })
})

/**
 * The same loop, wired to the deps the Worker actually uses, over `fakeOpfs`.
 *
 * `fakeDownloadEnv` cannot see this class of bug: its `openSink` hands back a plain object with
 * no registry behind it, so a test can assert "nothing was marked" while the real `openSink`
 * has already created the file and made it visible to `freeWheelVfs`. The question these tests
 * ask is the only one that matters — after a failed attempt, what can BRouter see?
 */
describe('runRegionDownload, against the real registry', () => {
  const item: DownloadItem = {
    kind: 'segment', key: 'W5_N50', url: 'https://example/W5_N50.rd5', bytes: 143654912, hash: 'bbbb2222',
  }
  const path = pathForItem('wessex', item)

  const failingFetch = () =>
    vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

  function bridge() {
    installVfsBridge()
    return (globalThis as unknown as { freeWheelVfs: { exists(p: string): boolean; size(p: string): number } })
      .freeWheelVfs
  }

  it('leaves a truncated orphan hidden when the retry fails before the first byte', async () => {
    // Last session died mid-segment: the file is short and durably marked.
    opfs.write(path, 500)
    await markDownloading(path, { hash: 'bbbb2222', bytes: item.bytes, started: true })
    // This is a cold start, so only the durable half survives — `pendingTargets` is in-memory.
    clearPending(path)

    expect(bridge().exists(path)).toBe(false)
    expect(await installedTiles()).toEqual([])

    await expect(
      runRegionDownload('wessex', [item], item.bytes, { ...opfsDownloadDeps, fetchImpl: failingFetch() }),
    ).rejects.toThrow('network down')

    // Still hidden. Opening this file up front to ask its size would have registered it at 500
    // bytes with nothing marking it, and BRouter would read a truncated .rd5 as corrupt data
    // rather than as an honest "no data for this area" — for the rest of the session.
    expect(bridge().exists(path)).toBe(false)
    expect(bridge().size(path)).toBe(-1)
    expect(await installedTiles()).toEqual([])
  })

  it('creates nothing when a first download fails before the first byte', async () => {
    await expect(
      runRegionDownload('wessex', [item], item.bytes, { ...opfsDownloadDeps, fetchImpl: failingFetch() }),
    ).rejects.toThrow('network down')

    // No 0-byte file. One would have no durable marker — `isTruncated` is false for a path
    // nothing is tracking — so `installedTiles()` would list it, at `bytes: 0`, on this and
    // every later cold start.
    expect(opfs.read(path)).toBeNull()
    expect(bridge().exists(path)).toBe(false)
    expect(await installedTiles()).toEqual([])
  })

  it('opens, writes and unhides the file when the bytes do arrive', async () => {
    // The positive control: deferring the open must not mean never opening it.
    const small: DownloadItem = { ...item, bytes: 6, hash: 'hs' }
    const fetchImpl = vi.fn(async () => new Response(text('abcdef'), { status: 200 }))

    await runRegionDownload('wessex', [small], 6, {
      ...opfsDownloadDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(bridge().exists(path)).toBe(true)
    expect(bridge().size(path)).toBe(6)
    expect(new TextDecoder().decode(opfs.read(path)!)).toBe('abcdef')
    expect((await installedTiles()).map((t) => t.tile)).toEqual(['W5_N50'])
  })

  it('resumes from what is on disk without having opened it to find out', async () => {
    // `peekSize` is not just a way to avoid opening — it has to give the same answer
    // `sink.size()` used to, or a resume restarts from zero and re-fetches 137 MB.
    const small: DownloadItem = { ...item, bytes: 10, hash: 'hs' }
    opfs.write(path, new TextEncoder().encode('efgh'))
    await markDownloading(path, { hash: 'hs', bytes: 10, started: true })
    clearPending(path)

    const resumed = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: 'bytes=4-' })
      return new Response(text('ijklmn'), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' } })
    })

    await runRegionDownload('wessex', [small], 10, {
      ...opfsDownloadDeps,
      fetchImpl: resumed as unknown as typeof fetch,
    })

    expect(resumed).toHaveBeenCalledTimes(1)
    expect(new TextDecoder().decode(opfs.read(path)!)).toBe('efghijklmn')
  })

  /**
   * A mirror that behaves: a `Range` request gets a `206` and the tail, anything else the whole
   * file. The behaviour matters, because the failure the next two tests pin is only visible in
   * the bytes. A resume onto a file this download never truncated appends the new tail to the
   * old prefix and lands on a file of exactly the right length — which is the one thing
   * `downloadInto`'s length check can never catch.
   */
  const mirror = (content: string) =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range
      if (!range) return new Response(text(content), { status: 200 })
      const from = Number(/bytes=(\d+)-/.exec(range)![1])
      return new Response(text(content.slice(from)), {
        status: 206,
        headers: { 'Content-Range': `bytes ${from}-${content.length - 1}/${content.length}` },
      })
    })

  const thisMonth: DownloadItem = { ...item, bytes: 10, hash: 'this-month' }

  /**
   * Last month's segment on disk, complete and in use, and an attempt at this month's whose
   * open fails — `openHandle` gives up after about 820 ms when a second tab holds the file, and
   * `getFileHandle(create: true)` can fail under storage pressure. The fetch succeeds, so the
   * attempt gets as far as wanting to write.
   */
  async function openFails(): Promise<void> {
    opfs.write(path, text('LAST-MO'))
    expect((await installedTiles()).map((t) => t.tile)).toEqual(['W5_N50'])
    expect(bridge().exists(path)).toBe(true)

    await expect(
      runRegionDownload('wessex', [thisMonth], 10, {
        ...opfsDownloadDeps,
        openSink: async () => {
          throw new Error(`${path} is already open elsewhere — one tab at a time`)
        },
        fetchImpl: mirror('0123456789') as unknown as typeof fetch,
      }),
    ).rejects.toThrow('already open elsewhere')
  }

  it('leaves nothing a later attempt could resume onto when the open fails', async () => {
    await openFails()

    // The marker is there, and that is deliberate: it goes down before the open precisely so
    // that no ordering can leave the file registered and unmarked. The cost is that a file
    // nothing touched is now hidden, which is the safe direction — an honest "no data for this
    // area" rather than a segment that may be about to be half-overwritten.
    expect(await readPartialHash(path)).toEqual({ hash: 'this-month', bytes: 10, started: false })
    expect(bridge().exists(path)).toBe(false)
    expect(await installedTiles()).toEqual([])

    // What the marker must not say is that this download has written anything. It records the
    // *new* hash against the *old* bytes, and a marker that also claimed to have started would
    // let the next attempt resume at byte 7 of last month's segment.
    expect(new TextDecoder().decode(opfs.read(path)!)).toBe('LAST-MO')
  })

  it('restarts from zero after a failed open, rather than appending to last month\'s bytes', async () => {
    await openFails()

    const retry = mirror('0123456789')
    await runRegionDownload('wessex', [thisMonth], 10, {
      ...opfsDownloadDeps,
      fetchImpl: retry as unknown as typeof fetch,
    })

    // No `Range` header: the whole file, from the top.
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry.mock.calls[0][1]?.headers).toBeUndefined()
    // And so the file is this month's segment and nothing else. A resume would have produced
    // `LAST-MO789` — ten bytes, the length check satisfied, and BRouter routing on a splice.
    expect(new TextDecoder().decode(opfs.read(path)!)).toBe('0123456789')
    expect(bridge().exists(path)).toBe(true)
    expect((await installedTiles()).map((t) => t.tile)).toEqual(['W5_N50'])
  })

  it('treats a marker from a build with no state field as one that never started', async () => {
    // Exactly what the previous build wrote: a hash and a byte count, and no way to tell an
    // intention from a written prefix. The safe reading of a state that was never recorded is
    // the conservative one.
    opfs.write(path, text('efgh'))
    opfs.write('/downloads.json', text(JSON.stringify({ [path]: { hash: 'this-month', bytes: 10 } })))

    const retry = mirror('0123456789')
    await runRegionDownload('wessex', [thisMonth], 10, {
      ...opfsDownloadDeps,
      fetchImpl: retry as unknown as typeof fetch,
    })

    expect(retry.mock.calls[0][1]?.headers).toBeUndefined()
    expect(new TextDecoder().decode(opfs.read(path)!)).toBe('0123456789')
  })
})

describe('completeRegionDownload', () => {
  const items: DownloadItem[] = [
    { kind: 'basemap', key: 'wessex', url: 'https://example/basemap.pmtiles', bytes: 10, hash: '1111aaaa' },
    { kind: 'segment', key: 'W5_N50', url: 'https://example/W5_N50.rd5', bytes: 6, hash: 'bbbb2222' },
  ]

  /** Both of the region's files downloaded but not yet committed: on disk, and marked. */
  async function downloaded(): Promise<string[]> {
    const paths = items.map((item) => pathForItem('wessex', item))
    for (const [i, path] of paths.entries()) {
      opfs.write(path, items[i].bytes)
      await markDownloading(path, { hash: items[i].hash, bytes: items[i].bytes, started: true })
    }
    return paths
  }

  it('records the region and then forgets every marker it set', async () => {
    const paths = await downloaded()

    const records = await completeRegionDownload(manifest.regions[0], manifest, items, 1)

    expect(records).toEqual([wessex])
    // The state a fresh Worker would read back, not just the value returned.
    expect(await readRecords()).toEqual([wessex])
    for (const path of paths) expect(await readPartialHash(path)).toBeNull()
  })

  it('leaves the markers alone until it is called', async () => {
    // A region commits nothing until every item is down, so a failure on the last item has to
    // leave the earlier ones recognisable — a retry reads these markers to skip them rather
    // than re-fetching 90 MB it already has.
    const paths = await downloaded()
    for (const path of paths) expect(await readPartialHash(path)).not.toBeNull()
  })

  it('replaces the previous record for the same region rather than appending', async () => {
    await downloaded()
    await completeRegionDownload(manifest.regions[0], manifest, items, 1)
    await completeRegionDownload(manifest.regions[0], manifest, items, 2)

    const records = await readRecords()
    expect(records).toHaveLength(1)
    expect(records[0].installedAt).toBe(2)
  })
})

describe('deleteRegionFiles', () => {
  it('takes the basemap\'s markers with the basemap', async () => {
    // The order this runs in on a real removal: the file goes, and anything still claiming the
    // file is mid-download would outlive it and hide whatever lands at that path next.
    const path = `${BASEMAP_DIR}/wessex.pmtiles`
    opfs.write(path, 500)
    await markDownloading(path, { hash: 'mirror', bytes: 90000000, started: true })

    await deleteRegionFiles([], 'wessex.pmtiles')

    expect(await readPartialHash(path)).toBeNull()
    expect(opfs.read(path)).toBeNull()
  })

  it('takes a segment\'s markers with the segment', async () => {
    const path = `${SEGMENT_DIR}/W5_N50.rd5`
    opfs.write(path, 500)
    await markDownloading(path, { hash: 'mirror', bytes: 143654912, started: true })

    await deleteRegionFiles(['W5_N50'], '')

    expect(await readPartialHash(path)).toBeNull()
    expect(opfs.read(path)).toBeNull()
  })
})
