import { describe, expect, it, vi } from 'vitest'
import { downloadInto, resumeDecision, type ByteSink } from './downloads'

function fakeSink(initial = new Uint8Array(0)) {
  let bytes = initial
  const sink: ByteSink & { readonly bytes: Uint8Array } = {
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
  return sink
}

const body = (text: string) => new TextEncoder().encode(text)

describe('resumeDecision', () => {
  it('starts from scratch when nothing is on disk', () => {
    expect(resumeDecision({ bytes: 0, hash: null, started: false }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('resumes a partial download of the same file', () => {
    expect(resumeDecision({ bytes: 40, hash: 'aaaa1111', started: true }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'resume', at: 40 })
  })

  it('is done when the file is already the right length', () => {
    expect(resumeDecision({ bytes: 100, hash: 'aaaa1111', started: true }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'done' })
  })

  it('starts over when a different version is half-written, rather than splicing two files', () => {
    expect(resumeDecision({ bytes: 40, hash: 'older111', started: true }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('starts over when the file on disk is longer than the target', () => {
    expect(resumeDecision({ bytes: 140, hash: 'aaaa1111', started: true }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  // A marker is written before the file is opened, so that the file is hidden from the moment
  // it can change. Everything below is about the gap that opens up between those two moments:
  // until the download has actually truncated the file, the marker records an intention, and
  // the bytes on disk are still the previous download's.
  it('will not resume onto a file the marker only claimed', () => {
    expect(resumeDecision({ bytes: 40, hash: 'aaaa1111', started: false }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('will not call a file done on the strength of a marker that never started', () => {
    // The hash in a marker is the hash of what is being fetched, never of what is on disk. An
    // unstarted marker over a file that happens to be the target length describes an older
    // file of a coincidentally identical size, not a finished download.
    expect(resumeDecision({ bytes: 100, hash: 'aaaa1111', started: false }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('reads a marker from an older build, which has no state at all, as not started', () => {
    expect(resumeDecision({ bytes: 40, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })
})

describe('downloadInto', () => {
  it('writes a whole file and reports progress', async () => {
    const sink = fakeSink()
    const seen: number[] = []
    const fetchImpl = vi.fn(async () => new Response(body('abcdefghij'), { status: 200 }))
    await downloadInto(sink, 'https://example/x', 10, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProgress: (received) => seen.push(received),
    })
    expect(new TextDecoder().decode(sink.bytes)).toBe('abcdefghij')
    expect(seen.at(-1)).toBe(10)
  })

  it('asks for the rest with a Range header and appends it', async () => {
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async () =>
      new Response(body('efghij'), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' } }),
    )
    await downloadInto(sink, 'https://example/x', 10, {
      from: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Range: 'bytes=4-' } })
    expect(new TextDecoder().decode(sink.bytes)).toBe('abcdefghij')
  })

  it('restarts from zero when the server ignores the Range and sends the whole file', async () => {
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async () => new Response(body('ABCDEFGHIJ'), { status: 200 }))
    await downloadInto(sink, 'https://example/x', 10, {
      from: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(new TextDecoder().decode(sink.bytes)).toBe('ABCDEFGHIJ')
  })

  it('throws when the download is short, which is what truncation looks like', async () => {
    const sink = fakeSink()
    const fetchImpl = vi.fn(async () => new Response(body('abc'), { status: 200 }))
    await expect(
      downloadInto(sink, 'https://example/x', 10, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/expected 10 bytes, wrote 3/)
  })

  it('reports an HTTP error rather than writing the error page into the file', async () => {
    const sink = fakeSink()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(
      downloadInto(sink, 'https://example/x', 10, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/404/)
    expect(sink.bytes.length).toBe(0)
  })
})

describe('downloadInto: untrustworthy 206 responses', () => {
  it('restarts from zero when a 206 claims a Content-Range that does not start where we asked', async () => {
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async () =>
      // Claims range 0-9, not 4-9: a server bug, or a cache/proxy that mislabels a full
      // response as partial. Trusting the status code alone would write this at offset 4,
      // producing a file of the right length that is wrong from byte 0.
      new Response(body('ABCDEFGHIJ'), { status: 206, headers: { 'Content-Range': 'bytes 0-9/10' } }),
    )
    await downloadInto(sink, 'https://example/x', 10, {
      from: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(new TextDecoder().decode(sink.bytes)).toBe('ABCDEFGHIJ')
  })

  it('asks again without a Range header when a 206 has no readable Content-Range', async () => {
    // The live case, and it is not a server bug: a cross-origin bucket that omits
    // `Access-Control-Expose-Headers: Content-Range` hides the header from JS while sending a
    // perfectly correct partial response. The bytes below are the *tail*, as a real 206's
    // would be — writing them at zero would make a 10-byte file that is wrong from byte 0.
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range
      return range
        ? new Response(body('efghij'), { status: 206 })
        : new Response(body('ABCDEFGHIJ'), { status: 200 })
    })

    await downloadInto(sink, 'https://example/x', 10, {
      from: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    // The prefix is discarded and the whole file re-fetched: one wasted transfer, rather than
    // the endless oscillation that writing the tail at zero used to produce.
    expect(new TextDecoder().decode(sink.bytes)).toBe('ABCDEFGHIJ')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1]).not.toMatchObject({ headers: { Range: expect.anything() } })
  })

  it('hands a deferred sink the offset it will actually write at, not the one it asked for', async () => {
    // The sink source is what marks and truncates the file, so it has to be told that this
    // turned into a restart. Told `4`, it would mark the download as already started and
    // leave the old prefix in place.
    const offered: number[] = []
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.Range
        ? new Response(body('efghij'), { status: 206 })
        : new Response(body('ABCDEFGHIJ'), { status: 200 }),
    )

    await downloadInto(
      async (at) => {
        offered.push(at)
        return sink
      },
      'https://example/x',
      10,
      { from: 4, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(offered).toEqual([0])
  })

  it('refuses a partial response to a request that asked for the whole file', async () => {
    // Nothing to retry here — we sent no Range header, so a second identical request would
    // get the same unplaceable fragment. Failing says so instead of writing a tail at zero.
    const sink = fakeSink()
    const fetchImpl = vi.fn(async () => new Response(body('efghij'), { status: 206 }))

    await expect(
      downloadInto(sink, 'https://example/x', 10, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('partial response to a request for the whole file')
    expect(sink.bytes.length).toBe(0)
  })

  it('gives up when even the no-Range retry answers with an unplaceable partial', async () => {
    const sink = fakeSink(body('abcd'))
    const fetchImpl = vi.fn(async () => new Response(body('efghij'), { status: 206 }))

    await expect(
      downloadInto(sink, 'https://example/x', 10, {
        from: 4,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('answered a request for the whole file with another one')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // Untouched: two unplaceable responses must not cost the rider the bytes already down.
    expect(new TextDecoder().decode(sink.bytes)).toBe('abcd')
  })
})

describe('downloadInto: resuming after a mid-stream failure', () => {
  it('retains bytes written before the stream errors, flushes them, and a resumed call completes the file', async () => {
    const sink = fakeSink()
    const flushSpy = vi.spyOn(sink, 'flush')
    // `pull` rather than `start`: enqueueing then immediately erroring in `start` discards the
    // queued chunk (erroring a stream resets its internal queue per spec), which would test
    // nothing. Delivering one chunk via a successful `pull`, then erroring on the next `pull`,
    // is what a real dropped connection looks like — some bytes already handed to the reader.
    let pulls = 0
    const droppedFetch = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            if (pulls === 1) {
              controller.enqueue(body('abcd'))
            } else {
              controller.error(new Error('connection dropped'))
            }
          },
        }),
        { status: 200 },
      ),
    )

    await expect(
      downloadInto(sink, 'https://example/x', 10, { fetchImpl: droppedFetch as unknown as typeof fetch }),
    ).rejects.toThrow('connection dropped')

    // The point of the feature: the bytes received before the drop are on the sink at the
    // right offsets, not discarded, and flushed rather than left buffered.
    expect(new TextDecoder().decode(sink.bytes)).toBe('abcd')
    expect(flushSpy).toHaveBeenCalled()

    const resumedFetch = vi.fn(async () =>
      new Response(body('efghij'), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' } }),
    )
    await downloadInto(sink, 'https://example/x', 10, {
      from: sink.size(),
      fetchImpl: resumedFetch as unknown as typeof fetch,
    })

    expect(new TextDecoder().decode(sink.bytes)).toBe('abcdefghij')
  })
})
