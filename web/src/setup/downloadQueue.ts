import type { RegionProgress } from '../engine/downloads'
import { downloadFailure, formatMegabytes, itemWords, type DownloadFailure } from './pickerModel'

/**
 * The download queue, with the downloading left out.
 *
 * A rider taps three regions and walks away. What happens next has to survive the screen being
 * closed, the app being backgrounded, and one of the three failing — so the queue is a plain
 * list of jobs with a reducer over it, and the part that touches the engine (`downloadStore.ts`)
 * only ever hands this list back a new fact.
 *
 * Everything here is pure, which is the point: the ordering rules, the arithmetic behind the
 * progress bar and the words under it are the parts that can be wrong, and none of them need a
 * browser to check.
 */

export type JobState = 'queued' | 'downloading' | 'failed' | 'cancelled'

export interface DownloadJob {
  /** The region id. One job per region — a second tap on a running region is not a second job. */
  id: string
  name: string
  /** What the whole job costs, as priced when it was queued. */
  bytes: number
  state: JobState
  /** Live progress, or `null` before the first byte. */
  progress: RegionProgress | null
  /** Why it stopped, for a job in `failed`. */
  failure: DownloadFailure | null
}

/** A job for a region, priced and named. Starts queued; the store decides when it runs. */
export function queueJob(jobs: DownloadJob[], id: string, name: string, bytes: number): DownloadJob[] {
  // A region already in the list is re-armed rather than added again. Two jobs for one region
  // would each compute their plan from the same records and the second would re-fetch what the
  // first had just finished — and the engine serialises them, so the rider would wait twice for
  // one download.
  const existing = jobs.find((job) => job.id === id)
  if (existing && (existing.state === 'queued' || existing.state === 'downloading')) return jobs
  const fresh: DownloadJob = { id, name, bytes, state: 'queued', progress: null, failure: null }
  return existing ? jobs.map((job) => (job.id === id ? fresh : job)) : [...jobs, fresh]
}

/**
 * The job the store should run next, or `null`.
 *
 * One at a time, and not as a policy choice: the Worker serialises region operations anyway
 * (`regionStore.serializeRegionOp`), so starting three at once would only make three progress
 * bars crawl in lockstep while one of them actually moved. First queued wins, so the order a
 * rider tapped in is the order they get.
 */
export function nextJob(jobs: DownloadJob[]): DownloadJob | null {
  if (jobs.some((job) => job.state === 'downloading')) return null
  return jobs.find((job) => job.state === 'queued') ?? null
}

export function markRunning(jobs: DownloadJob[], id: string): DownloadJob[] {
  return jobs.map((job) =>
    job.id === id ? { ...job, state: 'downloading' as const, failure: null } : job,
  )
}

export function withProgress(jobs: DownloadJob[], id: string, progress: RegionProgress): DownloadJob[] {
  return jobs.map((job) => (job.id === id ? { ...job, progress } : job))
}

/**
 * A job that finished, whichever way it went.
 *
 * A success leaves the list entirely. There is nothing useful to say about a download that
 * worked — the region is in the library above with its size and its date, which is a better
 * statement of the same fact than a row saying "done".
 */
export function settle(jobs: DownloadJob[], id: string, error: unknown | null): DownloadJob[] {
  if (error === null) return jobs.filter((job) => job.id !== id)
  const state: JobState = isCancellation(error) ? 'cancelled' : 'failed'
  // A cancelled job leaves too: the rider asked for it to stop, and a row explaining that they
  // stopped it is the app repeating their own instruction back at them.
  if (state === 'cancelled') return jobs.filter((job) => job.id !== id)
  return jobs.map((job) =>
    job.id === id ? { ...job, state, failure: downloadFailure(error) } : job,
  )
}

export function dropJob(jobs: DownloadJob[], id: string): DownloadJob[] {
  return jobs.filter((job) => job.id !== id)
}

/**
 * Whether an error is the rider having changed their mind.
 *
 * By `name` rather than by message, because the message is a browser's to write and varies:
 * Safari's aborted fetch says "Fetch is aborted", Chrome's says "The user aborted a request".
 * Both are `AbortError`.
 */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** How far a job has got, 0–100, and 0 for one that has not started. */
export function jobPercent(job: DownloadJob): number {
  const progress = job.progress
  if (!progress || progress.overallTotal <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((progress.overallReceived / progress.overallTotal) * 100)))
}

/**
 * The words under a row's name.
 *
 * Kept short — this appears on up to fourteen rows at once, where the picker's full sentence
 * would be a wall. The detail a rider actually needs mid-download is which half is being
 * fetched and how far through it is; the region's own name is already on the row.
 */
export function jobLine(job: DownloadJob): string {
  switch (job.state) {
    case 'queued':
      return `Waiting — ${formatMegabytes(job.bytes)}`
    case 'cancelled':
      return 'Stopped'
    case 'failed':
      return job.failure?.message ?? 'The download stopped'
    case 'downloading': {
      const progress = job.progress
      if (!progress) return 'Starting…'
      if (progress.state === 'complete' && progress.overallReceived >= progress.overallTotal) {
        return 'Finishing up…'
      }
      return `${itemWords(progress.kind)} — ${formatMegabytes(progress.overallReceived)} of ${formatMegabytes(progress.overallTotal)}`
    }
  }
}

/**
 * One line for the whole queue, for somewhere that is not the Maps screen.
 *
 * `null` when there is nothing in flight, so a caller can render nothing at all rather than an
 * empty strip. A rider who has left the screen still deserves to know that 400 MB is arriving,
 * and to be able to get back to it.
 */
export function queueSummary(jobs: DownloadJob[]): { line: string; percent: number } | null {
  const live = jobs.filter((job) => job.state === 'queued' || job.state === 'downloading')
  if (live.length === 0) return null
  const running = live.find((job) => job.state === 'downloading')
  const waiting = live.length - (running ? 1 : 0)
  const name = running?.name ?? live[0].name
  const tail = waiting > 0 ? ` · ${waiting} more waiting` : ''
  return { line: `Downloading ${name}${tail}`, percent: running ? jobPercent(running) : 0 }
}
