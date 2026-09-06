/**
 * The saved plan: what is on the map, and what the rider has chosen off it.
 *
 * Plans go in localStorage so one survives the app being closed. That matters more here than
 * in most apps: the realistic workflow is planning at home and riding hours later, by which
 * time iOS has certainly evicted the page. GPX is stored verbatim rather than parsed, because
 * it is also what Export hands over — one representation, no chance of the two drifting.
 *
 * Kept out of `useRoute` because migration is the fiddly part and it is pure: given a blob off
 * disk, `migratePlan` decides what the rider gets back. That is worth testing directly.
 */

export interface Waypoint {
  id: string
  lon: number
  lat: number
}

export interface StoredPlan {
  v: number
  waypoints: Waypoint[]
  /** Profiles to route. One is the normal case; several is a comparison. */
  selection: string[]
  /**
   * The profile the rider has committed to, or `null` if a comparison is still open.
   *
   * `null` is the point of version 3. Version 2 stored a `focused` profile that was seeded
   * with 'trekking' and could never be empty, so after a comparison the elevation profile
   * described one of six routes with nothing on screen saying which.
   */
  chosen: string | null
  gpx?: Record<string, string>
}

export const PLAN_VERSION = 3

const STORAGE_KEY = 'free-wheel.plan.v2'

/** Beyond this, storing the GPX is more likely to blow the quota than to be useful. */
const MAX_STORED_GPX = 2_000_000

const EMPTY: StoredPlan = {
  v: PLAN_VERSION,
  waypoints: [],
  selection: ['trekking'],
  chosen: null,
}

/**
 * Turns whatever is on disk into a plan this version understands.
 *
 * Anything unrecognisable becomes the empty plan rather than a half-restored one: a corrupt
 * plan must never stop the app starting, and the map plus a fresh set of waypoints is still
 * perfectly useful.
 */
export function migratePlan(raw: unknown): StoredPlan {
  if (!raw || typeof raw !== 'object') return EMPTY
  const plan = raw as Partial<StoredPlan> & { focused?: unknown }
  if (!Array.isArray(plan.waypoints) || !Array.isArray(plan.selection)) return EMPTY
  if (plan.selection.length === 0) return EMPTY

  const gpx = plan.gpx && typeof plan.gpx === 'object' ? plan.gpx : undefined
  const routed = Object.keys(gpx ?? {})
  const base = {
    v: PLAN_VERSION,
    waypoints: plan.waypoints,
    selection: plan.selection,
    ...(gpx ? { gpx } : {}),
  }

  if (plan.v === PLAN_VERSION) {
    const chosen = typeof plan.chosen === 'string' ? plan.chosen : null
    return { ...base, chosen }
  }

  // Version 2 and earlier. `focused` was a default, not a decision, so it only survives where
  // it was the *only* possible answer — a single stored route. A stored comparison goes back
  // to the rider to choose, which is the whole point of the new flow.
  const focused = typeof plan.focused === 'string' ? plan.focused : null
  const chosen = routed.length === 1 && focused === routed[0] ? focused : null
  return { ...base, chosen }
}

/**
 * What to select once a run finishes.
 *
 * One result is not a choice — there is nothing to weigh it against, so committing to it
 * saves the rider a tap. Several results is exactly the decision we want them to make.
 */
export function chosenAfterRun(computedIds: string[]): string | null {
  return computedIds.length === 1 ? computedIds[0] : null
}

export function loadPlan(): StoredPlan {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return migratePlan(raw ? JSON.parse(raw) : null)
  } catch {
    return EMPTY
  }
}

export function savePlan(plan: Omit<StoredPlan, 'v'>): void {
  try {
    const total = Object.values(plan.gpx ?? {}).reduce((n, doc) => n + doc.length, 0)
    const stored: StoredPlan = { ...plan, v: PLAN_VERSION }
    if (!(total > 0 && total < MAX_STORED_GPX)) delete stored.gpx
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Quota, or private browsing. Losing persistence is not worth breaking the ride over.
  }
}
