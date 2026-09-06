import { useCallback, useEffect, useRef, useState } from 'react'
import { sharedEngine } from '../engine/engineClient'
import { tilesForWaypoints } from '../engine/tiles'
import { parseBrouterGpx, type ParsedRoute } from './gpx'

export interface Waypoint {
  id: string
  lon: number
  lat: number
}

/** The profiles shipped in `public/profiles2`, in the order a cyclist is likely to want them. */
export const PROFILES = [
  { id: 'trekking', label: 'Trekking', note: 'The sane default — quiet roads and decent surfaces' },
  { id: 'fastbike', label: 'Fast', note: 'Road bike; prefers speed over quiet' },
  { id: 'fastbike-verylowtraffic', label: 'Fast, quiet', note: 'Road bike, traffic-averse' },
  { id: 'gravel', label: 'Gravel', note: 'Happy on unsurfaced tracks' },
  { id: 'mtb', label: 'MTB', note: 'Off-road' },
  { id: 'shortest', label: 'Shortest', note: 'Distance only, ignores surface and traffic' },
] as const

/**
 * Air distance beyond which BRouter's search gets uncomfortably slow on a phone.
 *
 * Not a hard limit — the engine will try — but the cost scales roughly quadratically, and
 * 150 km already extrapolates to ~18 s on device. Warning beforehand is kinder than a UI
 * that appears to have hung.
 */
const AIR_DISTANCE_CEILING_M = 150_000

const STORAGE_KEY = 'free-wheel.plan.v1'

/**
 * Routes go in localStorage so a plan survives the app being closed.
 *
 * That matters more here than in most apps: the realistic workflow is planning at home and
 * riding hours later, by which time iOS has certainly evicted the page from memory. The GPX
 * is stored verbatim rather than the parsed form, because it is also what Export hands over
 * — one representation, no chance of the two drifting.
 */
const MAX_STORED_GPX = 2_000_000

interface StoredPlan {
  waypoints: Waypoint[]
  profile: string
  gpx?: string
}

function loadPlan(): StoredPlan | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredPlan
    if (!Array.isArray(parsed.waypoints)) return null
    return parsed
  } catch {
    // A corrupt or unreadable plan must never stop the app starting — the map and a fresh
    // set of waypoints are still perfectly useful.
    return null
  }
}

export interface RouteState {
  waypoints: Waypoint[]
  profile: string
  route: ParsedRoute | null
  gpx: string | null
  routing: boolean
  error: string | null
  /** Set when the route is long enough to be worth a word of warning before running. */
  warning: string | null
}

export function useRoute() {
  const restored = useRef<StoredPlan | null>(null)
  if (restored.current === null) restored.current = loadPlan() ?? { waypoints: [], profile: 'trekking' }

  const [waypoints, setWaypoints] = useState<Waypoint[]>(restored.current.waypoints)
  const [profile, setProfile] = useState<string>(restored.current.profile)
  const [gpx, setGpx] = useState<string | null>(restored.current.gpx ?? null)
  const [route, setRoute] = useState<ParsedRoute | null>(() => {
    const stored = restored.current?.gpx
    if (!stored) return null
    try {
      return parseBrouterGpx(stored)
    } catch {
      return null
    }
  })
  const [routing, setRouting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Persist whenever the plan changes. Cheap, and the alternative — persisting on unload —
  // does not fire reliably when iOS kills a backgrounded web app.
  useEffect(() => {
    try {
      const plan: StoredPlan = { waypoints, profile }
      if (gpx && gpx.length < MAX_STORED_GPX) plan.gpx = gpx
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
    } catch {
      // Quota, or private browsing. Losing persistence is not worth breaking the ride over.
    }
  }, [waypoints, profile, gpx])

  const addWaypoint = useCallback((lon: number, lat: number) => {
    setWaypoints((current) => [...current, { id: crypto.randomUUID(), lon, lat }])
  }, [])

  const moveWaypoint = useCallback((id: string, lon: number, lat: number) => {
    setWaypoints((current) => current.map((w) => (w.id === id ? { ...w, lon, lat } : w)))
  }, [])

  const removeWaypoint = useCallback((id: string) => {
    setWaypoints((current) => current.filter((w) => w.id !== id))
  }, [])

  const clear = useCallback(() => {
    setWaypoints([])
    setRoute(null)
    setGpx(null)
    setError(null)
  }, [])

  const run = useCallback(async () => {
    if (waypoints.length < 2) {
      setError('Tap the map to set a start and a finish.')
      return
    }
    setRouting(true)
    setError(null)
    try {
      const lonLats = waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|')
      const outcome = await sharedEngine().route(profile, lonLats)

      if (!outcome.ok || !outcome.gpx) {
        setError(explainRoutingFailure(outcome.error ?? 'routing failed', waypoints))
        setRoute(null)
        setGpx(null)
        return
      }

      setRoute(parseBrouterGpx(outcome.gpx))
      setGpx(outcome.gpx)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRoute(null)
      setGpx(null)
    } finally {
      setRouting(false)
    }
  }, [waypoints, profile])

  /** Kills the worker mid-route. See `engineClient.cancel` for why it has to be this blunt. */
  const cancel = useCallback(() => {
    sharedEngine().cancel()
    setRouting(false)
    setError('Cancelled.')
  }, [])

  const warning = longRouteWarning(waypoints)

  return {
    waypoints,
    profile,
    route,
    gpx,
    routing,
    error,
    warning,
    setProfile,
    addWaypoint,
    moveWaypoint,
    removeWaypoint,
    clear,
    run,
    cancel,
    setError,
  }
}

/**
 * Turns BRouter's diagnostics into something actionable.
 *
 * The important case by far is a missing `.rd5`: BRouter says "position not mapped in
 * existing datafile", which is accurate and completely unhelpful if you do not already know
 * that tiles are imported by hand. Naming the file to fetch turns a dead end into a task.
 */
function explainRoutingFailure(message: string, waypoints: Waypoint[]): string {
  // "segment directory /segments4 does not exist" is what BRouter says when no tiles are
  // imported at all — accurate, and unhelpful unless you already know tiles arrive by hand.
  if (/not mapped in existing datafile|datafile .* not found|segment directory .* does not exist/i.test(message)) {
    const needed = tilesForWaypoints(waypoints)
    return (
      `No routing data covering these points. You need ${needed.map((t) => `${t}.rd5`).join(' and ')} — ` +
      `download from brouter.de/brouter/segments4/ and import it in Setup.`
    )
  }
  if (/timeout|maxRunningTime/i.test(message)) {
    return 'The search ran out of time. Try a shorter route, or add a via point to guide it.'
  }
  return message
}

/** Great-circle distance in metres, good enough for a sanity check on route length. */
function airDistance(a: Waypoint, b: Waypoint): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function longRouteWarning(waypoints: Waypoint[]): string | null {
  if (waypoints.length < 2) return null
  let total = 0
  for (let i = 1; i < waypoints.length; i++) total += airDistance(waypoints[i - 1], waypoints[i])
  if (total < AIR_DISTANCE_CEILING_M) return null
  return `That is ${Math.round(total / 1000)} km as the crow flies. Routing cost grows roughly with the square of distance, so this may take a while or time out.`
}
