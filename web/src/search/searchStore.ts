import { useSyncExternalStore } from 'react'
import { sharedEngine } from '../engine/engineClient'
import type { IndexProgress } from './buildIndex'
import {
  loadIndex,
  mergeHits,
  searchIndex,
  type LoadedIndex,
  type SearchHit,
} from './placeIndex'
import { dropIndex, indexIsCurrent, indexedArchives, placesAvailable, readIndex, writeIndex } from './placeStore'

/**
 * The place index, owned by the app rather than by a screen.
 *
 * Same argument as `downloadStore`, and the same shape. Building an index takes seconds and
 * blocks the engine Worker; holding it in the search screen's state would mean it started when
 * the rider opened search, which is the one moment they are waiting for an answer. So it is a
 * module singleton, kicked from `App` when the installed archives change, and the search screen
 * subscribes to whatever it finds there.
 *
 * ## It refuses to build while the rider is riding
 *
 * The Worker is single-threaded and a build holds it for a few seconds. The next thing it might
 * be asked for is the reroute that gets a lost rider home, and a reroute that waits behind an
 * index build is the worst possible trade. `hold(true)` stops the queue between archives;
 * `hold(false)` starts it again. Nothing is lost by waiting — the map still draws every name it
 * always did.
 *
 * ## Why the loaded form is cached here and not rebuilt per search
 *
 * `loadIndex` folds 35,000 names into one searchable string. Doing that per keystroke would be
 * absurd; doing it per screen open would be a visible pause on the screen that has to feel
 * instant. Once per archive per session, here.
 */

type Listener = () => void

export interface IndexState {
  /** Archives with a usable index loaded. */
  ready: string[]
  /** The archive being scanned right now, if any. */
  building: string | null
  /** 0–1 through the archive being scanned. */
  progress: number
  /** Archives still waiting for an index. */
  outstanding: string[]
  /** Why the last attempt failed, if it did. */
  problem: string | null
  /** True while a ride is in progress and building is deliberately suspended. */
  held: boolean
}

const listeners = new Set<Listener>()
const loaded = new Map<string, LoadedIndex>()

let state: IndexState = {
  ready: [],
  building: null,
  progress: 0,
  outstanding: [],
  problem: null,
  held: false,
}

/** What the last `sync` was told is installed, so a release can pick up where it left off. */
let installed: { name: string; bytes: number }[] = []
let running = false

function publish(next: Partial<IndexState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = () => state

/**
 * Brings the index in line with what is installed.
 *
 * Idempotent and cheap when nothing has changed, because it is called on startup, whenever a
 * region lands and whenever one is removed — the same three moments `useMapLibre.sync` is called
 * at, and for the same reason: one entry point rather than three places deciding the same thing.
 */
async function sync(archives: { name: string; bytes: number }[]): Promise<void> {
  installed = archives
  const names = new Set(archives.map((archive) => archive.name))

  // A region the rider deleted. Its index is a megabyte describing streets they can no longer
  // route on, and leaving it would offer them as destinations.
  for (const name of [...loaded.keys()]) if (!names.has(name)) loaded.delete(name)
  if (placesAvailable()) {
    try {
      for (const name of await indexedArchives()) if (!names.has(name)) await dropIndex(name)
    } catch {
      // Housekeeping. A failure here costs disk, never correctness.
    }
  }

  await pump()
}

/** Works through whatever is missing, one archive at a time. Re-entrant, like the download pump. */
async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (const archive of installed) {
      if (state.held) break
      if (loaded.has(archive.name)) continue

      try {
        const stored = placesAvailable() ? await readIndex(archive.name) : undefined
        if (indexIsCurrent(stored, archive.bytes)) {
          loaded.set(archive.name, loadIndex(stored!))
          publish({ ready: [...loaded.keys()], outstanding: outstanding() })
          continue
        }
      } catch (e) {
        publish({ problem: message(e) })
      }

      if (state.held) break
      publish({ building: archive.name, progress: 0, problem: null })
      try {
        const built = await sharedEngine().buildPlaceIndex(archive.name, (progress: IndexProgress) =>
          publish({
            progress: progress.tilesTotal > 0 ? progress.tilesDone / progress.tilesTotal : 0,
          }),
        )
        loaded.set(archive.name, loadIndex(built))
        // Stored after it is loaded, not before: a rider who can search now should not be made
        // to wait on a database write, and a failed write only costs the next launch a rebuild.
        if (placesAvailable()) await writeIndex(built).catch(() => undefined)
        publish({ building: null, progress: 0, ready: [...loaded.keys()], outstanding: outstanding() })
      } catch (e) {
        publish({ building: null, progress: 0, problem: message(e) })
      }
    }
  } finally {
    running = false
    publish({ outstanding: outstanding() })
  }
}

const outstanding = () => installed.filter((a) => !loaded.has(a.name)).map((a) => a.name)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Suspends and resumes building.
 *
 * Called by the ride screen when a ride starts and ends. Not a cancel: whatever is already in
 * flight finishes — it is seconds, and a half-scanned archive is not a thing that can be stored
 * — but nothing new starts until the rider is off the bike.
 */
function hold(held: boolean): void {
  if (state.held === held) return
  publish({ held })
  if (!held) void pump()
}

/**
 * Everything matching, across every installed region, best first.
 *
 * Synchronous, and that is the point of all the machinery above: by the time a rider is typing,
 * the answer is a native string scan over something already in memory.
 */
function search(
  query: string,
  near: { lon: number; lat: number } | null,
  limit = 25,
): SearchHit[] {
  if (loaded.size === 0) return []
  return mergeHits(
    [...loaded.values()].map((index) => searchIndex(index, query, near, limit)),
    limit,
  )
}

export const places = { subscribe, snapshot, sync, hold, search }

/** The index's state, for a screen that wants to say what it is waiting for. */
export function useIndexState(): IndexState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
