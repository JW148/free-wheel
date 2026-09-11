import { createHash } from 'node:crypto'

/** First 8 hex characters of the SHA-256. Long enough that a collision is not a real risk here. */
export function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 8)
}

/**
 * Whether a fetched segment is worth republishing.
 *
 * `identical-bytes` is the case that matters. brouter.de rebuilds every segment weekly
 * regardless of whether OpenStreetMap changed anything inside it, so publishing on
 * `Last-Modified` alone would tell a rider to re-download 137 MB for no change at all.
 */
export function decideSegmentAction({ status, upstreamHash, mirrored }) {
  if (status === 304) return { action: 'skip', reason: 'not-modified' }
  if (!upstreamHash) {
    throw new Error(`a ${status} response produced no hash — refusing to publish an unnamed object`)
  }
  if (mirrored && mirrored.hash === upstreamHash) return { action: 'skip', reason: 'identical-bytes' }
  return { action: 'publish', hash: upstreamHash }
}
