/**
 * The places a rider keeps: home, work, and wherever else they keep going.
 *
 * ## Why localStorage and not the two other stores
 *
 * The route library's argument, run the other way. A saved place is forty bytes; twenty of them
 * is under a kilobyte, which is nothing against localStorage's ~5 MB — and unlike a route it
 * has to be readable **synchronously at startup**, because the search screen's first paint is a
 * list of them and a list that arrives a frame late is a list that jumps. IndexedDB would make
 * the one screen that has to feel instant the one screen that waits.
 *
 * ## Recents are a different list, and the difference matters
 *
 * A saved place is a decision: the rider named it and it stays until they delete it. A recent is
 * an observation — somewhere they went — and it ages out. Keeping them in one list would mean
 * either recents that never expire or saved places that quietly vanish, and the second is the
 * kind of bug a rider cannot even report.
 *
 * Everything here is pure except the two reads and the two writes, so the rules — how a place is
 * matched, what gets pushed off the end of the recents, what a blank name falls back to — are
 * testable without a browser.
 */

export type PlaceIcon = 'home' | 'work' | 'star'

export interface SavedPlace {
  id: string
  name: string
  lon: number
  lat: number
  icon: PlaceIcon
  savedAt: number
}

/** Somewhere the rider started or finished at. Not named, and allowed to age out. */
export interface RecentPlace {
  name: string
  lon: number
  lat: number
  /** What the app called it — "Street", "Town or village" — so the row reads the same twice. */
  detail: string
  at: number
}

const SAVED_KEY = 'free-wheel.places.v1'
const RECENT_KEY = 'free-wheel.recent-places.v1'

/**
 * How many recents are kept.
 *
 * Six, because the list sits above the keyboard on a 390px phone and anything below the fold is
 * a list nobody scrolls — they would type instead, which is the thing the list exists to save
 * them from.
 */
export const MAX_RECENTS = 6

/** Two points this close together are the same place arrived at twice. About a street corner. */
const SAME_PLACE_M = 60

/**
 * Whether two points are the same place, by a flat approximation.
 *
 * Deliberately not `haversineM`: this is asked once per item per save, the threshold is 60 m,
 * and the error in a flat projection over 60 m is microns. Keeping it self-contained also keeps
 * this module free of anything that knows about routes.
 */
function samePlace(a: { lon: number; lat: number }, b: { lon: number; lat: number }): boolean {
  const scale = Math.cos((a.lat * Math.PI) / 180)
  const dx = (a.lon - b.lon) * scale * 111_320
  const dy = (a.lat - b.lat) * 111_320
  return dx * dx + dy * dy < SAME_PLACE_M * SAME_PLACE_M
}

/**
 * The recents list after visiting somewhere.
 *
 * Pure, and the two rules it enforces are both about not showing the rider the same row twice:
 * an arrival at somewhere already in the list **moves** it to the top rather than adding a
 * second copy, and the list is cut to {@link MAX_RECENTS} from the bottom.
 */
export function withRecent(recents: RecentPlace[], place: RecentPlace): RecentPlace[] {
  const rest = recents.filter((entry) => !(entry.name === place.name && samePlace(entry, place)))
  return [place, ...rest].slice(0, MAX_RECENTS)
}

/**
 * A place, ready to save.
 *
 * A blank name falls back to the coordinates rather than to an empty row — the same rule the
 * route library's `defaultRouteName` follows, and for the same reason: every entry in a list is
 * identified by its name, so there is no such thing as one without.
 */
export function placeEntry(input: {
  name: string
  lon: number
  lat: number
  icon?: PlaceIcon
  at?: number
}): SavedPlace {
  const at = input.at ?? Date.now()
  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || `${input.lat.toFixed(4)}, ${input.lon.toFixed(4)}`,
    lon: input.lon,
    lat: input.lat,
    icon: input.icon ?? iconFor(input.name),
    savedAt: at,
  }
}

/**
 * Which glyph a name earns without being asked.
 *
 * Two names out of all possible names, because those two are the ones every rider saves and
 * neither is worth a picker. Everything else is a star, and the picker is there for a rider who
 * disagrees.
 */
export function iconFor(name: string): PlaceIcon {
  const folded = name.trim().toLowerCase()
  if (folded === 'home') return 'home'
  if (folded === 'work' || folded === 'office') return 'work'
  return 'star'
}

/** Saved places, most recently saved last — home and work stay where the rider put them. */
export function loadPlaces(): SavedPlace[] {
  return read<SavedPlace[]>(SAVED_KEY, []).filter(
    (place) =>
      typeof place?.id === 'string' &&
      typeof place.name === 'string' &&
      Number.isFinite(place.lon) &&
      Number.isFinite(place.lat),
  )
}

export function savePlaces(places: SavedPlace[]): void {
  write(SAVED_KEY, places)
}

export function loadRecents(): RecentPlace[] {
  return read<RecentPlace[]>(RECENT_KEY, []).filter(
    (place) =>
      typeof place?.name === 'string' && Number.isFinite(place.lon) && Number.isFinite(place.lat),
  )
}

export function saveRecents(recents: RecentPlace[]): void {
  write(RECENT_KEY, recents)
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T) : fallback
  } catch {
    // Corrupt, or private browsing. An empty list is a working screen; a throw here is a
    // search that cannot open.
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota, or private browsing. Losing a shortcut is not worth breaking the search over.
  }
}
