import { describe, expect, it } from 'vitest'
import { decideSegmentAction, hashOf } from './decide.mjs'

describe('hashOf', () => {
  it('is eight stable hex characters', () => {
    expect(hashOf(Buffer.from('brouter'))).toMatch(/^[0-9a-f]{8}$/)
    expect(hashOf(Buffer.from('brouter'))).toBe(hashOf(Buffer.from('brouter')))
    expect(hashOf(Buffer.from('brouter'))).not.toBe(hashOf(Buffer.from('brouterr')))
  })
})

describe('decideSegmentAction', () => {
  it('publishes a segment that has never been mirrored', () => {
    expect(decideSegmentAction({ status: 200, upstreamHash: 'aaaa1111', mirrored: undefined }))
      .toEqual({ action: 'publish', hash: 'aaaa1111' })
  })

  it('skips a 304, because upstream said nothing changed', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(decideSegmentAction({ status: 304, upstreamHash: null, mirrored }))
      .toEqual({ action: 'skip', reason: 'not-modified' })
  })

  it('skips a rebuild whose bytes are identical, which is the weekly case', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(decideSegmentAction({ status: 200, upstreamHash: 'aaaa1111', mirrored }))
      .toEqual({ action: 'skip', reason: 'identical-bytes' })
  })

  it('publishes when the bytes really differ', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(decideSegmentAction({ status: 200, upstreamHash: 'bbbb2222', mirrored }))
      .toEqual({ action: 'publish', hash: 'bbbb2222' })
  })

  it('throws when a 200 response produces no hash and mirrored entry exists', () => {
    const mirrored = { url: 'segments4/W5_N55-aaaa1111.rd5', bytes: 10, hash: 'aaaa1111', changed: '2026-08-24T00:00:00Z' }
    expect(() => decideSegmentAction({ status: 200, upstreamHash: null, mirrored }))
      .toThrow(/a 200 response produced no hash/)
  })

  it('throws when a 200 response produces no hash and no mirrored entry', () => {
    expect(() => decideSegmentAction({ status: 200, upstreamHash: null, mirrored: undefined }))
      .toThrow(/a 200 response produced no hash/)
  })
})
