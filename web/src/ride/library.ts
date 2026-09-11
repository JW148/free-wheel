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

/**
 * What the library is showing.
 *
 * The list was one undivided stream, on the argument that a route and a ride are the same
 * object to a rider and the useful ordering is by *when*, across both. That argument holds and
 * `'all'` is still the default — but it turned out to be only half the story. Once rides
 * accumulate they are the bulk of the list, and "the route I planned for Saturday" gets
 * pushed off the bottom by a fortnight of commutes. So the ordering stays and a filter sits
 * above it: three taps of context, not a tab bar you have to choose before you can look.
 */
export type LibraryFilter = 'all' | 'route' | 'ride'

/** Pure, so the toggle's behaviour is testable without a database. */
export function filterEntries<T extends { kind: 'route' | 'ride' }>(
  entries: T[],
  filter: LibraryFilter,
): T[] {
  return filter === 'all' ? entries : entries.filter((entry) => entry.kind === filter)
}

/**
 * An entry under a new name, or under its old one if the new name is blank.
 *
 * Blank is not a valid name here — every entry is identified in a list by its name, and the
 * generated one ("8 Sep · 34.2 km") is better than an empty row. Clearing the field therefore
 * reverts rather than erases, which is also what stops a fumbled rename destroying the only
 * label on a ride.
 */
export function renamed<T extends LibraryEntry>(entry: T, name: string): T {
  return { ...entry, name: name.trim() || entry.name }
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
  return (open ??= new Promise<IDBDatabase>((resolve, reject) => {
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
  }).catch((reason) => {
    // A *rejected* promise must not stay in the cache. `??=` would keep it forever, so one
    // transient failure — another tab mid-upgrade, a browser still starting up — would disable
    // the library until the app was reloaded, with the library button reporting the same stale
    // error every time it was tapped.
    open = null
    throw reason
  }))
}

/**
 * Runs one request and settles on the **transaction**, not on the request.
 *
 * The obvious version resolves in `request.onsuccess`, and it is wrong in a way that only
 * shows up when it matters. A request succeeds when the database has accepted it; the data is
 * not durable until the transaction *commits*, and a commit can still fail — which is exactly
 * what a quota overrun does. Resolving early reports a successful save that was then rolled
 * back, and the rider finds out when the list comes back empty.
 *
 * A failed commit also fires `abort` rather than `error`, so an abort with no prior request
 * error left the promise unsettled forever: the save button would spin until the app was
 * reloaded.
 */
function run<T>(store: string, mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>) {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(store, mode)
        const request = act(transaction.objectStore(store))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        request.onerror = () => reject(request.error ?? new Error('library request failed'))
        transaction.oncomplete = () => resolve(result)
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('the route library ran out of room'))
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

export const getRide = (id: string) => run<SavedRide | undefined>(RIDES, 'readonly', (s) => s.get(id))

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
