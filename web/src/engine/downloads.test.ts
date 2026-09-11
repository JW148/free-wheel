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
    expect(resumeDecision({ bytes: 0, hash: null }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('resumes a partial download of the same file', () => {
    expect(resumeDecision({ bytes: 40, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'resume', at: 40 })
  })

  it('is done when the file is already the right length', () => {
    expect(resumeDecision({ bytes: 100, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'done' })
  })

  it('starts over when a different version is half-written, rather than splicing two files', () => {
    expect(resumeDecision({ bytes: 40, hash: 'older111' }, { bytes: 100, hash: 'aaaa1111' }))
      .toEqual({ action: 'start' })
  })

  it('starts over when the file on disk is longer than the target', () => {
    expect(resumeDecision({ bytes: 140, hash: 'aaaa1111' }, { bytes: 100, hash: 'aaaa1111' }))
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
