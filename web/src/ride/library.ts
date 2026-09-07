import type { Waypoint } from './plan'
import type { ParsedRoute } from './gpx'
import type { RideSummary } from './recording'

/**
 * Saved routes and finished rides.
 *
 * ## Why IndexedDB and not the two stores this app already has
 *
 * `localStorage` holds the *current* plan and it is the right place for it: one small object,
 * read synchronously at startup, and losing it costs one re-tap. A library is different — a
 * 95 km route's GPX is 240 kB, and WebKit's localStorage quota is about 5 MB *per origin,
 * shared with everything else the app keeps there*. Twenty saved routes would evict the plan,
 * the theme and the basemap choice along with themselves, and the failure would arrive as a
 * silent `QuotaExceededError` inside `savePlan`'s catch block.
 *
 * OPFS is the app's other store, and it is the wrong shape: it exists to serve
 * `FileSystemSyncAccessHandle` reads from the engine Worker, and the whole registry is built
 * around the rule that exactly one handle may be open per file. Routes want small keyed records
 * with a query, not byte ranges.
 *
 * IndexedDB is what is left, and it is also simply the right answer: async, main-thread-safe,
 * quota shared with OPFS at ~60% of the disk, and durable in a home-screen PWA. The wrapper
 * below is ~60 lines because nothing here needs more than get, put, delete and getAll.
 *
 * ## Why the summary is stored alongside the GPX
 *
 * The list has to render distance, time and climbing for every entry. Parsing twenty GPX
 * documents to draw a list is work the phone can see, and the figures never change once
 * saved — so they are denormalised on write. The GPX stays the source of truth for the map.
 */

export interface SavedRoute {
  id: string
  name: string
  savedAt: number
  kind: 'route'
  waypoints: Waypoint[]
  /** The profile it was routed with, so reopening it restores the comparison's outcome. */
  profile: string
  gpx: string
  distanceM: number
  timeS: number | null
  ascentM: number
  /** A handful of coordinates, for the shape drawn next to the name. */
  preview: [number, number][]
}

export interface SavedRide {
  id: string
  name: string
  savedAt: number
  kind: 'ride'
  summary: RideSummary
  gpx: string
  preview: [number, number][]
}

export type LibraryEntry = SavedRoute | SavedRide

const DB_NAME = 'free-wheel'
const DB_VERSION = 1
const ROUTES = 'routes'
const RIDES = 'rides'

/** Points kept for the thumbnail. Enough to tell a loop from an out-and-back at 44 px. */
const PREVIEW_POINTS = 48

/**
 * Evenly spaced points along a route, for drawing a shape rather than a map.
 *
 * Stride rather than a simplification algorithm: Douglas–Peucker would keep the corners and
 * drop the straights, which is right for a map and wrong here — at thumbnail size the corners
 * are sub-pixel and what reads is the overall proportion. Always keeps both ends, so a loop
 * closes.
 */
export function previewOf(coords: [number, number][]): [number, number][] {
  if (coords.length <= PREVIEW_POINTS) return coords
  const stride = (coords.length - 1) / (PREVIEW_POINTS - 1)
  const out: [number, number][] = []
  for (let i = 0; i < PREVIEW_POINTS - 1; i++) out.push(coords[Math.round(i * stride)])
  out.push(coords[coords.length - 1])
  return out
}

/**
 * What a route is called when the rider does not name it.
 *
 * Date and distance, because those are the two things that distinguish one entry from another
 * in a list — and because the alternative, naming it after its endpoints, needs a geocoder,
 * which needs a network, which this app does not have. A rider who wants "Pentlands loop" can
 * type it; everyone else gets something they can still pick out of a list a month later.
 */
export function defaultRouteName(at: number, distanceM: number): string {
  const date = new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${date} · ${distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`}`
}

export function routeEntry(input: {
  name: string
  waypoints: Waypoint[]
  profile: string
  gpx: string
  route: ParsedRoute
  at?: number
}): SavedRoute {
  const at = input.at ?? Date.now()
  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || defaultRouteName(at, input.route.distanceM),
    savedAt: at,
    kind: 'route',
    waypoints: input.waypoints,
    profile: input.profile,
    gpx: input.gpx,
    distanceM: input.route.distanceM,
    timeS: input.route.timeS,
    ascentM: input.route.ascendM,
    preview: previewOf(input.route.coords),
  }
}

export function rideEntry(input: {
  name: string
  summary: RideSummary
  gpx: string
  trace: { lon: number; lat: number }[]
}): SavedRide {
  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || defaultRouteName(input.summary.startedAt, input.summary.distanceM),
    savedAt: input.summary.startedAt,
    kind: 'ride',
    summary: input.summary,
    gpx: input.gpx,
    preview: previewOf(input.trace.map((p) => [p.lon, p.lat] as [number, number])),
  }
}

/** Newest first. What a rider wants: the thing they saved last is the thing they want back. */
export function byNewest<T extends { savedAt: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.savedAt - a.savedAt)
}

/** Whether the library can work at all. False in a context with IndexedDB disabled. */
export function libraryAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

let open: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  // Cached, because opening on every call serialises behind the version-change transaction and
  // makes a list of twenty entries twenty round trips.
  return (open ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(ROUTES)) {
        database.createObjectStore(ROUTES, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(RIDES)) {
        database.createObjectStore(RIDES, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('could not open the route library'))
    // Another tab holding an old version open. Nothing to do but say so.
    request.onblocked = () => reject(new Error('another tab has the route library open'))
  }))
}

function run<T>(store: string, mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>) {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(store, mode)
        const request = act(transaction.objectStore(store))
        request.onsuccess = () => resolve(request.result)
        // Both, because a request can succeed and its transaction still fail on commit —
        // which is exactly what a quota overrun looks like.
        request.onerror = () => reject(request.error ?? new Error('library request failed'))
        transaction.onerror = () => reject(transaction.error ?? new Error('library write failed'))
      }),
  )
}

const storeFor = (kind: 'route' | 'ride') => (kind === 'route' ? ROUTES : RIDES)

export const listRoutes = () => run<SavedRoute[]>(ROUTES, 'readonly', (s) => s.getAll()).then(byNewest)
export const listRides = () => run<SavedRide[]>(RIDES, 'readonly', (s) => s.getAll()).then(byNewest)

export const putEntry = (entry: LibraryEntry) =>
  run(storeFor(entry.kind), 'readwrite', (s) => s.put(entry)).then(() => entry)

export const deleteEntry = (kind: 'route' | 'ride', id: string) =>
  run(storeFor(kind), 'readwrite', (s) => s.delete(id)).then(() => undefined)

export const getRoute = (id: string) =>
  run<SavedRoute | undefined>(ROUTES, 'readonly', (s) => s.get(id))

/**
 * Asks the browser to stop evicting this origin under storage pressure.
 *
 * Worth doing precisely because of what is stored here: a 34 MB basemap and a 150 MB routing
 * tile are exactly the things a browser reclaims first, and losing them is discovered in
 * airplane mode at the side of a road. Safari grants this silently for a home-screen app and
 * usually refuses it in a tab, so the answer is reported rather than assumed.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
