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

import { haversineM } from './geo'
import { DEFAULT_PROFILES } from './profiles'

export interface Waypoint {
  id: string
  lon: number
  lat: number
  /**
   * What the rider called this point, when they chose it by name.
   *
   * Only ever a name they were *given*: a search result, a saved place. Never derived from the
   * coordinates. The rule in CLAUDE.md — there is no geocoder, and where a design shows a place
   * name the app shows coordinates — is about turning a position into a name, which is a thing
   * this app will not do. Remembering a name the rider picked off a list is the opposite
   * direction and costs nothing. A point tapped on the map still has none, and still shows its
   * coordinates.
   */
  label?: string
  /**
   * Where this point came from, when it was not a tap on the map.
   *
   * `'reroute'` is a point the app added on the rider's behalf: rejoining the route after a
   * wrong turn keeps the original start and every via already passed, and records where the
   * rider rejoined as one more point along the way (see `stitch.ts`). It is drawn as a quiet
   * dot rather than a numbered pin and does not shift the numbering of the ones the rider
   * placed — a point you did not put there should not look like one you did.
   *
   * Optional, so a plan written by an earlier version restores unchanged.
   */
  kind?: 'reroute'
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

export const PLAN_VERSION = 4

const STORAGE_KEY = 'free-wheel.plan.v2'

/** Beyond this, storing the GPX is more likely to blow the quota than to be useful. */
const MAX_STORED_GPX = 2_000_000

const EMPTY: StoredPlan = {
  v: PLAN_VERSION,
  waypoints: [],
  selection: [...DEFAULT_PROFILES],
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

  /*
   * Version 3. The selection was a tick-list the rider built by hand and usually left at one;
   * now it is the three cards the second tap computes. So a plan with **nothing computed** is
   * a plan whose selection was never really a decision, and it gets the new default — that is
   * the whole point of the upgrade, and leaving it at one profile would silently give every
   * existing install the old one-route flow forever.
   *
   * A plan that *does* carry routes keeps its selection exactly. It describes what is on the
   * map, and widening it would mean the next reroute quietly computed profiles the rider never
   * asked for.
   */
  const upgraded =
    plan.v === 3 && routed.length === 0 ? { ...base, selection: [...DEFAULT_PROFILES] } : base

  if (plan.v === 3) {
    const chosen = typeof plan.chosen === 'string' ? plan.chosen : null
    return { ...upgraded, chosen }
  }

  // Version 2 and earlier. `focused` was a default, not a decision, so it only survives where
  // it was the *only* possible answer — a single stored route. A stored comparison goes back
  // to the rider to choose, which is the whole point of the new flow.
  const focused = typeof plan.focused === 'string' ? plan.focused : null
  const chosen = routed.length === 1 && focused === routed[0] ? focused : null
  return { ...upgraded, chosen }
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

/** Where a searched place goes in the plan. */
export type PlanSlot = 'start' | 'finish' | 'stop'

/**
 * The plan after putting a place at one end of it, or in the middle.
 *
 * Pure, because the interesting part is not the assignment but the four shapes a plan can be in
 * when a rider picks a destination: empty, one point, two, or two with stops between them. A
 * finish chosen on an empty plan has to become the *only* point rather than the second of two
 * — otherwise the app is quietly routing from nowhere.
 *
 * Points the app placed itself are dropped first. A rejoin point belongs to the ride it was
 * added during (see `stitch.ts`); carrying one into a plan the rider has just typed a new
 * destination into would route them through a layby they passed last Tuesday.
 */
export function withEndpoint(
  waypoints: Waypoint[],
  slot: PlanSlot,
  point: { lon: number; lat: number; label?: string },
): Waypoint[] {
  const placed = waypoints.filter((w) => w.kind !== 'reroute')
  const next: Waypoint = {
    id: crypto.randomUUID(),
    lon: point.lon,
    lat: point.lat,
    ...(point.label ? { label: point.label } : {}),
  }

  if (placed.length === 0) return [next]
  if (slot === 'start') return [next, ...placed.slice(1)]
  if (slot === 'stop') {
    return placed.length === 1
      ? [...placed, next]
      : [...placed.slice(0, -1), next, placed[placed.length - 1]]
  }
  return placed.length === 1 ? [...placed, next] : [...placed.slice(0, -1), next]
}

/**
 * Where a point tapped on the map belongs in the order.
 *
 * The app's oldest rule is that a tap places a waypoint, and the second oldest is that there
 * are no modes — so there is no "add a via" gesture to arm. The tap simply goes wherever it
 * costs least, and the rider never thinks about the order at all.
 *
 * Cost is the **detour it would add**: for a leg `a → b`, `d(a,p) + d(p,b) − d(a,b)`, compared
 * against `d(finish,p)`, which is what extending past the finish would cost. Cheapest wins. So
 * a tap beside the line bends it, a tap past the finish lengthens it, and both fall out of one
 * comparison rather than a rule the rider has to learn.
 *
 * Measured over the **waypoints**, not the drawn route. Nearest-point-on-the-line is the
 * obvious alternative and is worse twice over: it has no answer at all when the route is
 * stale, failed or not yet computed, and for a tap well off the line — "swing out to the
 * coast" — the nearest point on the line says nothing about how far out of the way it is.
 *
 * Prepending is **not** a candidate. A tap behind the start turning into a new start is
 * surprising, and the search's start slot and dragging the start pin both already do it
 * properly. Ties go to the earlier leg, which only arises on a closed loop, where the two
 * legs are coincident and the rider's intent is ambiguous anyway — see `plan.test.ts`.
 */
export function insertionIndex(
  waypoints: { lon: number; lat: number }[],
  point: { lon: number; lat: number },
): number {
  if (waypoints.length < 2) return waypoints.length

  const p: [number, number] = [point.lon, point.lat]
  const to = (w: { lon: number; lat: number }): [number, number] => [w.lon, w.lat]

  // The extend-past-the-finish candidate, which is what a two-point plan did before there was
  // any notion of a stop at all.
  let bestIndex = waypoints.length
  let bestCost = haversineM(to(waypoints[waypoints.length - 1]), p)

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = to(waypoints[i])
    const b = to(waypoints[i + 1])
    const cost = haversineM(a, p) + haversineM(p, b) - haversineM(a, b)
    if (cost < bestCost) {
      bestCost = cost
      bestIndex = i + 1
    }
  }

  return bestIndex
}

/**
 * How close the two ends have to be for the plan to already be a loop.
 *
 * Generous on purpose. The ends coincide exactly when "Make a loop" put them there, but a
 * rider who dragged their finish back onto their own front door is describing the same ride,
 * and offering to close a loop that is already closed is an action with nothing to do.
 */
const LOOP_CLOSED_M = 50

/** Whether the plan already finishes where it started. */
export function isLoop(waypoints: { lon: number; lat: number }[]): boolean {
  if (waypoints.length < 2) return false
  const start = waypoints[0]
  const finish = waypoints[waypoints.length - 1]
  return haversineM([start.lon, start.lat], [finish.lon, finish.lat]) < LOOP_CLOSED_M
}

/** What a point is, and what its pin is labelled. */
export interface WaypointRow {
  id: string
  role: 'start' | 'via' | 'finish' | 'rejoin'
  /** The pin's own text: `S`, `F`, a stop's number, or nothing at all for a rejoin. */
  badge: string
  /** The same thing in words, for a list and for a screen reader. */
  word: string
}

/**
 * Every point, named and numbered.
 *
 * One function because three surfaces draw this same list — the pins on the map, the plan card
 * and the sheet's point list — and each used to derive it for itself from `index === 0`,
 * `index === length - 1` and a counter of its own. Three copies of one rule is three places to
 * fix when the rule changes, and historically only one of them ever got fixed.
 *
 * Numbering counts only the points the rider placed. A reroute adds a point where they rejoined
 * the route — that is what keeps the original start; see `stitch.ts` — and it is not a stop they
 * chose. Counting it would renumber every pin after it in the middle of a ride, and naming it
 * like the others would claim they put it there.
 */
export function waypointRows(waypoints: Waypoint[]): WaypointRow[] {
  let placed = 0
  return waypoints.map((waypoint, index) => {
    const last = index === waypoints.length - 1
    const rejoin = waypoint.kind === 'reroute' && !last && index > 0
    const ordinal = rejoin ? placed : placed++
    if (rejoin) return { id: waypoint.id, role: 'rejoin', badge: '', word: 'Rejoined' }
    if (index === 0) return { id: waypoint.id, role: 'start', badge: 'S', word: 'Start' }
    if (last) return { id: waypoint.id, role: 'finish', badge: 'F', word: 'Finish' }
    return { id: waypoint.id, role: 'via', badge: String(ordinal), word: `Stop ${ordinal}` }
  })
}
