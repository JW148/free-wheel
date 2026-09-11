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
 *
 * It is handed the offset the first write will land at — the *trusted* one, after the
 * `Content-Range` check below, not the one the caller asked for — so that a source with
 * bookkeeping of its own can tell a resume from a restart. A source may truncate at offset
 * zero itself; {@link downloadInto} truncates too, and a second `truncate(0)` is a no-op, so
 * the guarantee stays here rather than becoming something every caller has to remember.
 */
export type ByteSinkSource = ByteSink | ((from: number) => Promise<ByteSink>)

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
 * by the tail of this month's, which is a file that parses and routes wrongly. It only stops it
 * together with `existing.started` — see below.
 */
export function resumeDecision(
  existing: { bytes: number; hash: string | null; started?: boolean },
  target: { bytes: number; hash: string },
): ResumeDecision {
  // A marker that has not started says nothing about the bytes on disk, so it authorises
  // nothing. It is written before the file is opened — that is what hides a file from the
  // moment it can change — and until the truncate has succeeded, the hash it carries is the
  // hash of what is being fetched over a file that still holds the *previous* download. Reading
  // that as a match is what turns a failed open into a resume at the old length: last month's
  // prefix, this month's tail, the right number of bytes, and nothing left to catch it.
  //
  // `done` is refused for the same reason and not only `resume`: an unstarted marker over a
  // file that happens to be the target length describes an older file of a coincidentally
  // identical size, not a finished download. A marker written by a build from before this
  // field existed has no state to read, and is treated the same way — a restart, never a
  // splice.
  if (existing.started !== true) return { action: 'start' }
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

/**
 * Where a response's bytes belong, or `null` if there is no way to know.
 *
 * A `200` is the whole file, so it goes at zero — that is the safe reading of a server that
 * ignored our `Range` header. A `206` is a fragment, and the only thing that says which
 * fragment is `Content-Range`: if it names the byte we asked to resume from, the bytes go
 * there, and in every other case — no header, an unparseable one, or one naming a different
 * offset — the response is a fragment we cannot place. That is `null`, never zero: writing a
 * tail at offset zero produces a file of exactly the right length and wrong from its first
 * byte, which is the one corruption the length check below cannot see.
 */
function placementOf(response: Response, asked: number): number | null {
  if (response.status !== 206) return 0
  return contentRangeStart(response.headers.get('Content-Range')) === asked ? asked : null
}

export async function downloadInto(
  sink: ByteSinkSource,
  url: string,
  expectedBytes: number,
  options: DownloadOptions = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  const from = options.from ?? 0

  const request = async (at: number): Promise<Response & { body: ReadableStream<Uint8Array> }> => {
    const result = await doFetch(url, at > 0 ? { headers: { Range: `bytes=${at}-` } } : {})
    if (!result.ok) {
      throw new Error(`${url}: server returned ${result.status}`)
    }
    if (!result.body) {
      throw new Error(`${url}: response had no body`)
    }
    return result as Response & { body: ReadableStream<Uint8Array> }
  }

  let response = await request(from)
  let offset = placementOf(response, from)

  // An unplaceable partial, which in practice means a cross-origin `206` whose `Content-Range`
  // the browser will not show us: a bucket that omits `Access-Control-Expose-Headers:
  // Content-Range` hides the header from JS even though the server sent it, and the fetch
  // itself is perfectly healthy. So the fix is to stop asking for a range and take the whole
  // file, which is what the plain-`200` path already does safely.
  //
  // Throwing instead was the alternative. It was rejected because the condition never clears
  // by itself: the header is a property of someone else's bucket configuration, so every
  // retry from the phone would hit it again, and the rider would be stuck on a region that
  // can never finish downloading. Before this, the code wrote the tail at offset zero, hit
  // the length check, and left a *shorter* file for the next attempt to resume from — an
  // oscillation that re-fetched most of a 137 MB segment every time while the screen promised
  // it was picking up where it stopped. One discarded prefix is the cheaper failure.
  if (offset === null) {
    await response.body.cancel().catch(() => {})
    if (from === 0) {
      // We never asked for a range, so a partial answer is not something a retry can improve.
      throw new Error(`${url}: server sent a partial response to a request for the whole file`)
    }
    response = await request(0)
    offset = placementOf(response, 0)
    if (offset === null) {
      await response.body.cancel().catch(() => {})
      throw new Error(
        `${url}: server sent an unplaceable partial response, and answered a request for ` +
          `the whole file with another one`,
      )
    }
  }

  // The last moment at which the target is still untouched, and the first at which bytes are
  // certain to land on it. A deferred sink is acquired here and nowhere earlier, so a caller
  // whose acquisition has side effects — opening an OPFS handle creates the file and makes it
  // visible to the engine — pays them only when the download has actually got this far.
  let target: ByteSink
  try {
    target = typeof sink === 'function' ? await sink(offset) : sink
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
