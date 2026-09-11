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

export interface DownloadOptions {
  from?: number
  fetchImpl?: typeof fetch
  onProgress?: (received: number, total: number) => void
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

export async function downloadInto(
  sink: ByteSink,
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
  // offset would produce a file the right length and wrong throughout.
  let offset = response.status === 206 ? from : 0
  if (offset === 0) sink.truncate(0)

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sink.write(value, offset)
      offset += value.byteLength
      options.onProgress?.(offset, expectedBytes)
    }
  } finally {
    sink.flush()
  }

  if (offset !== expectedBytes) {
    throw new Error(`${url}: expected ${expectedBytes} bytes, wrote ${offset}`)
  }
}
