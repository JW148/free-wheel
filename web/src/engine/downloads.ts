/**
 * Streamed, resumable downloads into OPFS.
 *
 * Two things shape this. A phone loses wifi partway through a 137 MB segment often enough
 * that resuming matters, and the bytes must never be buffered whole: `arrayBuffer()` on a
 * segment file would be a 137 MB spike on a device with a tab budget.
 *
 * Integrity is a length check rather than a hash. `SubtleCrypto` has no streaming digest, so
 * hashing would mean holding the file in memory, and the realistic failure here is a
 * truncated download, which the length catches for free.
 */

export type ResumeDecision =
  | { action: 'start' }
  | { action: 'resume'; at: number }
  | { action: 'done' }

/** Somewhere to put bytes. An interface so this is testable without OPFS, which is Worker-only. */
export interface ByteSink {
  size(): number
  truncate(to: number): void
  write(chunk: Uint8Array, at: number): void
  flush(): void
}

/**
 * A sink, or a way to get one at the last possible moment.
 *
 * The deferred form exists because acquiring the sink is not free of consequences: in this app
 * it opens an OPFS handle, which creates the file if it is absent and registers it with the VFS
 * bridge — and registration alone is what makes a path visible to BRouter. A download that
 * fails before its first byte must leave the filesystem exactly as it found it, so a caller
 * that cares passes a function and {@link downloadInto} calls it only once bytes are certain.
 */
export type ByteSinkSource = ByteSink | (() => Promise<ByteSink>)

export interface DownloadOptions {
  from?: number
  fetchImpl?: typeof fetch
  onProgress?: (received: number, total: number) => void
}

/** Progress for one item of a region download, and the region's running total alongside it. */
export interface RegionProgress {
  key: string
  kind: 'basemap' | 'segment'
  received: number
  total: number
  overallReceived: number
  overallTotal: number
  state: 'downloading' | 'complete' | 'failed'
}

/**
 * Whether a partly-written file can be continued.
 *
 * The hash comparison is what stops the worst outcome: half of last month's segment followed
 * by the tail of this month's, which is a file that parses and routes wrongly.
 */
export function resumeDecision(
  existing: { bytes: number; hash: string | null },
  target: { bytes: number; hash: string },
): ResumeDecision {
  if (existing.hash !== target.hash) return { action: 'start' }
  if (existing.bytes === target.bytes) return { action: 'done' }
  if (existing.bytes === 0 || existing.bytes > target.bytes) return { action: 'start' }
  return { action: 'resume', at: existing.bytes }
}

/**
 * The start offset a `Content-Range: bytes 4-9/10` header claims, or `null` if the header is
 * missing or doesn't parse. A `206` is only trustworthy when this matches the byte we asked
 * the server to resume from — see the note in `downloadInto`.
 */
function contentRangeStart(header: string | null): number | null {
  if (!header) return null
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(header)
  return match ? Number(match[1]) : null
}

export async function downloadInto(
  sink: ByteSinkSource,
  url: string,
  expectedBytes: number,
  options: DownloadOptions = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  const from = options.from ?? 0
  const response = await doFetch(url, from > 0 ? { headers: { Range: `bytes=${from}-` } } : {})

  if (!response.ok) {
    throw new Error(`${url}: server returned ${response.status}`)
  }
  if (!response.body) {
    throw new Error(`${url}: response had no body`)
  }

  // A server that ignores Range answers 200 with the whole file. Writing that at the resume
  // offset would produce a file the right length and wrong throughout — and the length check
  // can't catch it, because the length comes out right. A `206` has the same failure mode if
  // its `Content-Range` doesn't actually start where we asked: trusting the status code alone
  // leaves that hole open, so the header is parsed and checked against `from` before the
  // response is trusted as a genuine partial-content answer. Anything else — no `206`, no
  // header, or a header that starts somewhere else — is treated as a full response from byte
  // zero, the same safe fallback the plain-`200` case takes.
  const trustedResume = response.status === 206 && contentRangeStart(response.headers.get('Content-Range')) === from
  let offset = trustedResume ? from : 0

  // The last moment at which the target is still untouched, and the first at which bytes are
  // certain to land on it. A deferred sink is acquired here and nowhere earlier, so a caller
  // whose acquisition has side effects — opening an OPFS handle creates the file and makes it
  // visible to the engine — pays them only when the download has actually got this far.
  let target: ByteSink
  try {
    target = typeof sink === 'function' ? await sink() : sink
    if (offset === 0) target.truncate(0)
  } catch (error) {
    // Nobody is going to read this body now. Left un-cancelled it holds the connection until
    // GC gets around to it, which on a phone means a 137 MB transfer still running in the
    // background after the app has reported the download failed.
    await response.body.cancel().catch(() => {})
    throw error
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      target.write(value, offset)
      offset += value.byteLength
      options.onProgress?.(offset, expectedBytes)
    }
  } finally {
    target.flush()
  }

  if (offset !== expectedBytes) {
    throw new Error(`${url}: expected ${expectedBytes} bytes, wrote ${offset}`)
  }
}
