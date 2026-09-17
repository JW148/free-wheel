import type { PlaceIndex } from './placeIndex'

/**
 * Where a built place index lives between sessions.
 *
 * ## Its own database, not the route library's
 *
 * `library.ts` opens `free-wheel` and holds saved routes and rides — small keyed records the
 * rider made by hand and would be upset to lose. An index is a **derived** thing: about 0.9 MB
 * per region, rebuildable from an archive that is already on the phone, and worth nothing if it
 * is even slightly out of date. Keeping the two apart means a corrupt or oversized index can be
 * thrown away wholesale without a version bump on the store holding a rider's rides, and
 * without the schema of one ever having a reason to move for the other.
 *
 * ## Why not localStorage or OPFS
 *
 * The same argument the route library makes, only more so. localStorage is ~5 MB per origin
 * shared with the plan and the theme, and one region's index would be most of it. OPFS exists
 * here to serve synchronous handles to the engine Worker under a one-handle-per-file registry;
 * an index wants to be read whole, on the main thread, keyed by archive name.
 *
 * IndexedDB stores typed arrays natively, so the packed form goes in and comes back out without
 * a serialisation step — which for 35,000 entries is the difference between instant and a
 * visible pause.
 */

const DB_NAME = 'free-wheel-places'
const DB_VERSION = 1
const STORE = 'indexes'

let open: Promise<IDBDatabase> | null = null

export function placesAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

function db(): Promise<IDBDatabase> {
  return (open ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'archive' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('could not open the place index'))
    request.onblocked = () => reject(new Error('another tab has the place index open'))
  }).catch((reason) => {
    // A rejected promise must not stay in the cache — the same trap `library.ts` documents.
    // One transient failure would otherwise disable search until the app was reloaded.
    open = null
    throw reason
  }))
}

/** Settles on the transaction rather than the request. See `library.ts` for why that matters. */
function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>) {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE, mode)
        const request = act(transaction.objectStore(STORE))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        request.onerror = () => reject(request.error ?? new Error('place index request failed'))
        transaction.oncomplete = () => resolve(result)
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('the place index ran out of room'))
        transaction.onerror = () => reject(transaction.error ?? new Error('place index write failed'))
      }),
  )
}

export const readIndex = (archive: string) =>
  run<PlaceIndex | undefined>('readonly', (store) => store.get(archive))

export const writeIndex = (index: PlaceIndex) =>
  run('readwrite', (store) => store.put(index)).then(() => index)

export const dropIndex = (archive: string) =>
  run('readwrite', (store) => store.delete(archive)).then(() => undefined)

/** Every archive an index has been built for, so stale ones can be found without reading them. */
export const indexedArchives = () =>
  run<string[]>('readonly', (store) => store.getAllKeys() as IDBRequest<string[]>)

/**
 * Whether a stored index still describes the archive on disk.
 *
 * By size rather than by a hash, and deliberately: the archives are content-addressed by the
 * mirror, so an update is a different file with a different length, and hashing 34 MB to answer
 * a question the byte count already answers would cost seconds on every launch. A rebuild
 * missed because two versions of a region were the same length to the byte is a search that
 * finds a street which moved, which is the same failure an un-updated map already has.
 */
export function indexIsCurrent(index: PlaceIndex | undefined, bytes: number): boolean {
  return index !== undefined && index.sourceBytes === bytes
}
