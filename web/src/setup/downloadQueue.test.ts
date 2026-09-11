import { describe, expect, it } from 'vitest'
import type { RegionProgress } from '../engine/downloads'
import {
  dropJob,
  isCancellation,
  jobLine,
  jobPercent,
  markRunning,
  nextJob,
  queueJob,
  queueSummary,
  settle,
  withProgress,
  type DownloadJob,
} from './downloadQueue'

const progress = (over: Partial<RegionProgress> = {}): RegionProgress => ({
  key: 'W5_N50',
  kind: 'segment',
  received: 10,
  total: 100,
  overallReceived: 10,
  overallTotal: 100,
  state: 'downloading',
  ...over,
})

const queued = (...names: string[]): DownloadJob[] =>
  names.reduce((jobs, name) => queueJob(jobs, name, name, 1_000_000), [] as DownloadJob[])

describe('queueJob', () => {
  it('keeps the order regions were tapped in', () => {
    expect(queued('a', 'b', 'c').map((job) => job.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores a second tap on a region already queued', () => {
    const jobs = queueJob(queued('a'), 'a', 'a', 999)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].bytes).toBe(1_000_000)
  })

  it('ignores a tap on a region already downloading', () => {
    const jobs = queueJob(markRunning(queued('a'), 'a'), 'a', 'a', 999)
    expect(jobs[0].state).toBe('downloading')
  })

  it('re-arms a failed region in place rather than adding a second row', () => {
    const failed = settle(markRunning(queued('a', 'b'), 'a'), 'a', new Error('nope'))
    const jobs = queueJob(failed, 'a', 'a', 1_000_000)
    expect(jobs.map((job) => job.id)).toEqual(['a', 'b'])
    expect(jobs[0]).toMatchObject({ state: 'queued', failure: null })
  })
})

describe('nextJob', () => {
  it('takes the first queued job', () => {
    expect(nextJob(queued('a', 'b'))?.id).toBe('a')
  })

  it('runs nothing while something is running', () => {
    // The engine serialises region operations anyway, so a second concurrent download would
    // only produce a second bar that does not move.
    expect(nextJob(markRunning(queued('a', 'b'), 'a'))).toBeNull()
  })

  it('skips past a failed job to the next queued one', () => {
    const jobs = settle(markRunning(queued('a', 'b'), 'a'), 'a', new Error('nope'))
    expect(nextJob(jobs)?.id).toBe('b')
  })

  it('answers null for an empty queue', () => {
    expect(nextJob([])).toBeNull()
  })
})

describe('settle', () => {
  it('takes a finished job out of the list entirely', () => {
    // The library row above says everything a "done" row could, with a size and a date.
    expect(settle(markRunning(queued('a'), 'a'), 'a', null)).toEqual([])
  })

  it('takes a cancelled job out too', () => {
    const aborted = new DOMException('stopped', 'AbortError')
    expect(settle(markRunning(queued('a'), 'a'), 'a', aborted)).toEqual([])
  })

  it('keeps a failed job, with words a rider can act on', () => {
    const jobs = settle(markRunning(queued('a'), 'a'), 'a', new TypeError('Load failed'))
    expect(jobs[0].state).toBe('failed')
    expect(jobs[0].failure?.message).toBe('The connection dropped.')
  })

  it('does not leak a URL or a file extension into the failure', () => {
    const jobs = settle(
      markRunning(queued('a'), 'a'),
      'a',
      new Error('https://mirror.example/segments4/W5_N50.rd5: server returned 503'),
    )
    expect(jobs[0].failure?.message).toBe('The download server answered 503.')
  })
})

describe('isCancellation', () => {
  it('recognises an abort by name rather than by message', () => {
    // Safari says "Fetch is aborted"; Chrome says "The user aborted a request". Both are
    // AbortError, and neither message is ours to rely on.
    expect(isCancellation(new DOMException('Fetch is aborted', 'AbortError'))).toBe(true)
    expect(isCancellation(new Error('The user aborted a request'))).toBe(false)
  })
})

describe('jobPercent', () => {
  it('is zero before the first byte', () => {
    expect(jobPercent(queued('a')[0])).toBe(0)
  })

  it('tracks the whole region rather than the current file', () => {
    // A bar that restarts from zero for the basemap and then again for each segment reads as
    // three failures rather than one download.
    const jobs = withProgress(markRunning(queued('a'), 'a'), 'a', progress({ overallReceived: 25 }))
    expect(jobPercent(jobs[0])).toBe(25)
  })

  it('survives a region with nothing to fetch', () => {
    const jobs = withProgress(markRunning(queued('a'), 'a'), 'a', progress({ overallTotal: 0 }))
    expect(jobPercent(jobs[0])).toBe(0)
  })
})

describe('jobLine', () => {
  it('names what is being fetched in a rider’s words', () => {
    const jobs = withProgress(
      markRunning(queued('a'), 'a'),
      'a',
      progress({ kind: 'basemap', overallReceived: 5_000_000, overallTotal: 90_000_000 }),
    )
    expect(jobLine(jobs[0])).toBe('the map — 5.0 MB of 90 MB')
  })

  it('says it is finishing rather than pinning at 100% and still claiming to download', () => {
    const jobs = withProgress(
      markRunning(queued('a'), 'a'),
      'a',
      progress({ state: 'complete', overallReceived: 100, overallTotal: 100 }),
    )
    expect(jobLine(jobs[0])).toBe('Finishing up…')
  })

  it('gives a waiting job its price, which is the thing worth knowing about it', () => {
    expect(jobLine(queued('a')[0])).toBe('Waiting — 1.0 MB')
  })
})

describe('queueSummary', () => {
  it('is null when nothing is in flight', () => {
    expect(queueSummary([])).toBeNull()
    expect(queueSummary(settle(markRunning(queued('a'), 'a'), 'a', new Error('x')))).toBeNull()
  })

  it('names the running region and counts what is behind it', () => {
    const jobs = markRunning(queued('a', 'b', 'c'), 'a')
    expect(queueSummary(jobs)?.line).toBe('Downloading a · 2 more waiting')
  })

  it('drops the tail when there is only one', () => {
    expect(queueSummary(markRunning(queued('a'), 'a'))?.line).toBe('Downloading a')
  })
})

describe('dropJob', () => {
  it('leaves the rest of the queue alone', () => {
    expect(dropJob(queued('a', 'b', 'c'), 'b').map((job) => job.id)).toEqual(['a', 'c'])
  })
})
