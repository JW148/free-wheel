import { useCallback, useEffect, useRef, useState } from 'react'
import { sharedEngine } from '../engine/engineClient'
import { tilesForWaypoints } from '../engine/tiles'
import { haversineM } from './geo'
import { parseBrouterGpx, type ParsedRoute } from './gpx'

export interface Waypoint {
  id: string
  lon: number
  lat: number
}

/**
 * The profiles shipped in `public/profiles2`, in the order a cyclist is likely to want them.
 *
 * Each carries the colour used **when several are compared at once**. A lone route is drawn
 * near-white instead (see {@link SOLO_ROUTE_COLOUR}) — the chrome is deliberately free of hue,
 * and a single line does not need one to be unambiguous.
 *
 * Hue only appears where it earns its place. Three fully neutral colours are not separable:
 * checked against a dark surface, the best neutral trio managed ΔE 12.7 for normal vision
 * against a floor of 15 — unreadable as categories. These three (amber, slate blue, sage) pass
 * all six checks: worst adjacent pair ΔE 17.3 deuteranopia, 18.0 normal. They are muted enough
 * to sit with the slate palette and none of them is the orange that started this.
 *
 * Assigned by profile and never cycled, so ticking a fourth profile cannot repaint the three
 * already on screen — which would make the map unreadable exactly when you are reading it.
 * Rows carry a label and a swatch as well, so identity is never colour alone.
 */
export const PROFILES = [
  {
    id: 'trekking',
    label: 'Trekking',
    note: 'The sane default — quiet roads and decent surfaces',
    colour: '#b8873c',
  },
  { id: 'fastbike', label: 'Fast', note: 'Road bike; prefers speed over quiet', colour: '#4a86c4' },
  { id: 'gravel', label: 'Gravel', note: 'Happy on unsurfaced tracks', colour: '#5a9e63' },
  {
    id: 'fastbike-verylowtraffic',
    label: 'Fast, quiet',
    note: 'Road bike, traffic-averse',
    colour: '#9d7fa8',
  },
  { id: 'mtb', label: 'MTB', note: 'Off-road', colour: '#c4707a' },
  {
    id: 'shortest',
    label: 'Shortest',
    note: 'Distance only, ignores surface and traffic',
    colour: '#7f9aa8',
  },
] as const

/** What a single route is drawn in: the lightest slate, maximum contrast, no hue. */
export const SOLO_ROUTE_COLOUR = '#ccd0cf'

export type ProfileId = (typeof PROFILES)[number]['id']

export const profileById = (id: string) => PROFILES.find((p) => p.id === id) ?? PROFILES[0]

/**
 * Air distance beyond which BRouter's search gets uncomfortably slow on a phone.
 *
 * Not a hard limit — the engine will try — but the cost scales roughly quadratically, and
 * 150 km already extrapolates to ~18 s on device. Comparing profiles multiplies that by the
 * number selected, since the Worker routes them one at a time.
 */
const AIR_DISTANCE_CEILING_M = 150_000

const STORAGE_KEY = 'free-wheel.plan.v2'

/**
 * Plans go in localStorage so one survives the app being closed.
 *
 * That matters more here than in most apps: the realistic workflow is planning at home and
 * riding hours later, by which time iOS has certainly evicted the page. GPX is stored
 * verbatim rather than parsed, because it is also what Export hands over — one
 * representation, no chance of the two drifting.
 */
const MAX_STORED_GPX = 2_000_000

interface StoredPlan {
  waypoints: Waypoint[]
  selection: string[]
  focused: string
  gpx?: Record<string, string>
}

function loadPlan(): StoredPlan {
  const fallback: StoredPlan = { waypoints: [], selection: ['trekking'], focused: 'trekking' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as StoredPlan
    if (!Array.isArray(parsed.waypoints) || !Array.isArray(parsed.selection)) return fallback
    if (parsed.selection.length === 0) return fallback
    return parsed
  } catch {
    // A corrupt plan must never stop the app starting — the map and a fresh set of
    // waypoints are still perfectly useful.
    return fallback
  }
}

export function useRoute() {
  const restored = useRef<StoredPlan | null>(null)
  restored.current ??= loadPlan()

  const [waypoints, setWaypoints] = useState<Waypoint[]>(restored.current.waypoints)
  /** Profiles to route. One is the normal case; several is a comparison. */
  const [selection, setSelection] = useState<string[]>(restored.current.selection)
  /** Which result the stats rail and the elevation profile describe. */
  const [focused, setFocused] = useState<string>(restored.current.focused)
  const [gpx, setGpx] = useState<Record<string, string>>(restored.current.gpx ?? {})
  const [routes, setRoutes] = useState<Record<string, ParsedRoute>>(() => {
    const parsed: Record<string, ParsedRoute> = {}
    for (const [id, doc] of Object.entries(restored.current?.gpx ?? {})) {
      try {
        parsed[id] = parseBrouterGpx(doc)
      } catch {
        // Drop an unparseable stored route rather than refusing to start.
      }
    }
    return parsed
  })
  const [routing, setRouting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Persist on change. The alternative — persisting on unload — does not fire reliably when
  // iOS kills a backgrounded web app.
  useEffect(() => {
    try {
      const plan: StoredPlan = { waypoints, selection, focused }
      const total = Object.values(gpx).reduce((n, doc) => n + doc.length, 0)
      if (total > 0 && total < MAX_STORED_GPX) plan.gpx = gpx
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
    } catch {
      // Quota, or private browsing. Losing persistence is not worth breaking the ride over.
    }
  }, [waypoints, selection, focused, gpx])

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
    setRoutes({})
    setGpx({})
    setError(null)
  }, [])

  /** Toggles a profile in or out of the comparison, never leaving the selection empty. */
  const toggleProfile = useCallback((id: string) => {
    setSelection((current) => {
      if (current.includes(id)) {
        if (current.length === 1) return current
        const next = current.filter((p) => p !== id)
        setFocused((f) => (f === id ? next[0] : f))
        return next
      }
      setFocused(id)
      return [...current, id]
    })
  }, [])

  const run = useCallback(async () => {
    if (waypoints.length < 2) {
      setError('Tap the map to set a start and a finish.')
      return
    }
    setError(null)
    const lonLats = waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|')

    const computed: Record<string, ParsedRoute> = {}
    const documents: Record<string, string> = {}
    const failures: string[] = []

    // Sequentially, because the engine Worker blocks inside Wasm for the duration of a
    // route — issuing them in parallel would queue them anyway, and would lose the
    // per-profile progress the rider can see.
    for (const id of selection) {
      setRouting(id)
      const outcome = await sharedEngine().route(id, lonLats)
      if (!outcome.ok || !outcome.gpx) {
        failures.push(explainRoutingFailure(outcome.error ?? 'routing failed', waypoints))
        continue
      }
      try {
        computed[id] = parseBrouterGpx(outcome.gpx)
        documents[id] = outcome.gpx
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e))
      }
    }

    setRouting(null)
    setRoutes(computed)
    setGpx(documents)

    // A partial comparison is still useful — say what failed rather than discarding the rest.
    if (failures.length) setError([...new Set(failures)].join(' '))
    if (Object.keys(computed).length > 0 && !computed[focused]) {
      setFocused(Object.keys(computed)[0])
    }
  }, [waypoints, selection, focused])

  /** Kills the worker mid-route. See `engineClient.cancel` for why it has to be this blunt. */
  const cancel = useCallback(() => {
    sharedEngine().cancel()
    setRouting(null)
    setError('Cancelled.')
  }, [])

  return {
    waypoints,
    selection,
    focused,
    routes,
    gpx,
    /** The result the rail and elevation profile describe, if there is one. */
    route: routes[focused] ?? null,
    focusedGpx: gpx[focused] ?? null,
    routing,
    error,
    warning: longRouteWarning(waypoints, selection.length),
    setFocused,
    toggleProfile,
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
 * The case that matters is a missing `.rd5`. BRouter says "position not mapped in existing
 * datafile", which is accurate and completely unhelpful unless you already know that tiles
 * are imported by hand. Naming the file to fetch turns a dead end into a task.
 */
function explainRoutingFailure(message: string, waypoints: Waypoint[]): string {
  if (
    /not mapped in existing datafile|datafile .* not found|segment directory .* does not exist/i.test(
      message,
    )
  ) {
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

function longRouteWarning(waypoints: Waypoint[], profileCount: number): string | null {
  if (waypoints.length < 2) return null
  let total = 0
  for (let i = 1; i < waypoints.length; i++) {
    total += haversineM(
      [waypoints[i - 1].lon, waypoints[i - 1].lat],
      [waypoints[i].lon, waypoints[i].lat],
    )
  }
  if (total < AIR_DISTANCE_CEILING_M) return null
  const each = profileCount > 1 ? ` — and you are comparing ${profileCount} profiles, one after another` : ''
  return `That is ${Math.round(total / 1000)} km as the crow flies. Routing cost grows roughly with the square of distance${each}, so this may take a while or time out.`
}
