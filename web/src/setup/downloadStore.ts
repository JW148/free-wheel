import { useSyncExternalStore } from 'react'
import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import { sharedEngine } from '../engine/engineClient'
import {
  dropJob,
  markRunning,
  nextJob,
  queueJob,
  settle,
  withProgress,
  type DownloadJob,
} from './downloadQueue'

/**
 * The downloads, owned by the app rather than by a screen.
 *
 * A 137 MB region takes minutes. Holding that in a component's state means it dies when the
 * rider closes the screen, which in practice means the screen becomes something you have to sit
 * and watch — and the previous version went further and *exited to the ride view* the moment one
 * download finished, so a rider who wanted two regions had to find their way back and start
 * again.
 *
 * So this is a module singleton, like `sharedEngine`. A tap adds a job; the pump runs them one
 * at a time; anything that cares subscribes. Closing the Maps screen does nothing to it.
 *
 * ## Why it is not in the Worker
 *
 * The Worker already serialises region operations, so the *ordering* is not this module's to
 * enforce. What is here is the part a Worker cannot hold: a list a rider can see, reorder by
 * cancelling, and retry from. Keeping it on the main thread also means a Worker terminated by a
 * route cancel does not take the queue with it.
 */

type Listener = () => void

const listeners = new Set<Listener>()
let jobs: DownloadJob[] = []
/** The manifest each queued region was priced against, so the pump can start it later. */
const pending = new Map<string, { region: RegionEntry; manifest: DataManifest }>()
/** Notified when a region lands, so the map can splice the new archive in. */
const installedListeners = new Set<(regions: InstalledRegion[]) => void>()

function publish(next: DownloadJob[]): void {
  jobs = next
  for (const listener of listeners) listener()
}

/**
 * Runs the next job, if there is one and nothing is running.
 *
 * Re-entrant by design: every state change calls it, and it is a no-op unless the queue has
 * actually become free. That is cheaper to reason about than a scheduler that has to be
 * remembered at each of the five places a job can finish.
 */
function pump(): void {
  const job = nextJob(jobs)
  if (!job) return
  const work = pending.get(job.id)
  if (!work) {
    // Queued with nothing to run it from. Unreachable through `start`, which writes both
    // together — but a job that can never run must not sit at the head of the queue blocking
    // every one behind it.
    publish(dropJob(jobs, job.id))
    pump()
    return
  }

  publish(markRunning(jobs, job.id))

  void sharedEngine()
    .downloadRegion(work.region, work.manifest, (progress) => {
      // Guarded because progress crosses from the Worker asynchronously: a cancel that lands
      // first has already taken the job out of the list, and re-adding it here would put a row
      // back on screen that the rider has just dismissed.
      if (jobs.some((existing) => existing.id === job.id)) publish(withProgress(jobs, job.id, progress))
    })
    .then(
      (regions) => {
        pending.delete(job.id)
        publish(settle(jobs, job.id, null))
        for (const listener of installedListeners) listener(regions)
        pump()
      },
      (error: unknown) => {
        // The plan is kept on a failure: a retry is the same region against the same manifest,
        // and the engine recomputes what is left to fetch from what is on disk. Dropped only
        // when the job leaves the list for good.
        publish(settle(jobs, job.id, error))
        if (!jobs.some((existing) => existing.id === job.id)) pending.delete(job.id)
        pump()
      },
    )
}

export const downloads = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  snapshot(): DownloadJob[] {
    return jobs
  },

  /**
   * Called when a region has finished and been recorded, with the new record list.
   *
   * This is how the map learns to draw new territory without the Maps screen having to be
   * open — which it very often will not be, because the whole point of the queue is that a
   * rider can start four downloads and go and do something else.
   */
  onInstalled(listener: (regions: InstalledRegion[]) => void): () => void {
    installedListeners.add(listener)
    return () => installedListeners.delete(listener)
  },

  start(region: RegionEntry, manifest: DataManifest, bytes: number): void {
    pending.set(region.id, { region, manifest })
    publish(queueJob(jobs, region.id, region.name, bytes))
    pump()
  },

  /**
   * Stops a download and takes its row away.
   *
   * The engine is told first and the row goes immediately, rather than waiting for the abort to
   * come back: a cancel that takes two seconds to visibly happen gets tapped again. What is
   * already on disk stays there, so a later retry resumes.
   */
  cancel(id: string): void {
    void sharedEngine().cancelRegionDownload(id)
    pending.delete(id)
    publish(dropJob(jobs, id))
    pump()
  },

  /** Clears a failed row without retrying it. */
  dismiss(id: string): void {
    pending.delete(id)
    publish(dropJob(jobs, id))
    pump()
  },

  /** Puts a failed job back at the end of the queue, against the plan it was priced with. */
  retry(id: string): void {
    const job = jobs.find((existing) => existing.id === id)
    const work = pending.get(id)
    if (!job || !work) return
    publish(queueJob(dropJob(jobs, id), id, job.name, job.bytes))
    pump()
  },
}

/** The queue, as React state. */
export function useDownloads(): DownloadJob[] {
  return useSyncExternalStore(downloads.subscribe, downloads.snapshot, downloads.snapshot)
}
