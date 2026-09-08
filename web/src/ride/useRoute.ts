import { useCallback, useEffect, useRef, useState } from 'react'
import { sharedEngine } from '../engine/engineClient'
import { tilesForWaypoints } from '../engine/tiles'
import { haversineM } from './geo'
import { parseBrouterGpx, type ParsedRoute } from './gpx'
import { chosenAfterRun, loadPlan, savePlan, type StoredPlan, type Waypoint } from './plan'

export type { Waypoint } from './plan'

/**
 * Air distance beyond which BRouter's search gets uncomfortably slow on a phone.
 *
 * Not a hard limit — the engine will try — but the cost scales roughly quadratically, and
 * 150 km already extrapolates to ~18 s on device. Comparing profiles multiplies that by the
 * number selected, since the Worker routes them one at a time.
 */
const AIR_DISTANCE_CEILING_M = 150_000

/**
 * The plan: waypoints, which profiles to route them with, and which result the rider picked.
 *
 * `chosen` is the load-bearing piece. It is `null` while a comparison is open, and only a
 * rider's tap — on a line on the map, or on a row in the sheet — fills it in. Everything
 * downstream keys off that: the stats rail, the elevation profile, whether Start is offered,
 * and which line is drawn thick. The one exception is a run that returns a single route,
 * where there is nothing to weigh and committing saves a pointless tap.
 */
export function useRoute() {
  const restored = useRef<StoredPlan | null>(null)
  restored.current ??= loadPlan()

  const [waypoints, setWaypoints] = useState<Waypoint[]>(restored.current.waypoints)
  /** Profiles to route. One is the normal case; several is a comparison. */
  const [selection, setSelection] = useState<string[]>(restored.current.selection)
  /** The profile the rider committed to, or `null` while a comparison is still open. */
  const [chosen, setChosen] = useState<string | null>(restored.current.chosen)
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
    savePlan({ waypoints, selection, chosen, gpx })
  }, [waypoints, selection, chosen, gpx])

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
    setChosen(null)
    setError(null)
  }, [])

  /**
   * Toggles a profile in or out of the comparison, never leaving the selection empty.
   *
   * Deliberately does *not* choose the profile it adds. Ticking a box says "route this too";
   * choosing is a separate act, and conflating them is what made the old elevation profile
   * ambiguous. Unticking the chosen profile does drop the choice — it would otherwise point
   * at something no longer on the map.
   */
  const toggleProfile = useCallback((id: string) => {
    setSelection((current) => {
      if (current.includes(id)) {
        if (current.length === 1) return current
        setChosen((c) => (c === id ? null : c))
        return current.filter((p) => p !== id)
      }
      return [...current, id]
    })
  }, [])

  /** Commits to one of the computed routes. Ignored for a profile with no result to ride. */
  const chooseProfile = useCallback(
    (id: string) => {
      if (routes[id]) setChosen(id)
    },
    [routes],
  )

  /**
   * Puts a comparison back the way it was: no choice, every route in its own colour.
   *
   * The counterpart to {@link chooseProfile}, and the thing whose absence made a choice a
   * one-way door — once `chosen` was set there was no way back to the state that let you
   * weigh the routes against each other.
   */
  const clearChoice = useCallback(() => setChosen(null), [])

  const run = useCallback(async () => {
    if (waypoints.length < 2) {
      setError('Tap the map to set a start and a finish.')
      return
    }
    setError(null)
    setChosen(null)
    const lonLats = waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|')

    const computed: Record<string, ParsedRoute> = {}
    const documents: Record<string, string> = {}
    const failures: string[] = []

    // Sequentially, because the engine Worker blocks inside Wasm for the duration of a
    // route — issuing them in parallel would queue them anyway, and would lose the
    // per-profile progress the rider can see.
    try {
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
    } catch (e) {
      // The call itself rejecting — a worker that would not spawn — rather than a route that
      // could not be found. Without the `finally` below it leaves the button reading
      // "Routing…" until the app is reloaded.
      failures.push(e instanceof Error ? e.message : String(e))
    } finally {
      setRouting(null)
    }
    setRoutes(computed)
    setGpx(documents)
    setChosen(chosenAfterRun(Object.keys(computed)))

    // A partial comparison is still useful — say what failed rather than discarding the rest.
    if (failures.length) setError([...new Set(failures)].join(' '))
  }, [waypoints, selection])

  /**
   * Routes again from where the rider is now, through whatever is still ahead of them.
   *
   * Mid-ride, and so deliberately unlike {@link run} in three ways:
   *
   * - **One profile.** The comparison is over — the rider is on a road, committed. Routing six
   *   profiles one after another would take six times as long at the moment it matters most.
   * - **The plan is rewritten.** `waypoints` becomes the rider's position plus what is left,
   *   because a route that starts 20 km behind the rider is not a route they can follow, and a
   *   second reroute would otherwise be computed from the same stale start.
   * - **A failure changes nothing.** The old route stays on the map and the rider keeps
   *   whatever they had. The alternative — clearing the route because the reroute failed — is
   *   the worst possible response to being lost.
   *
   * `remaining` comes from `waypointsAhead`, which is what stops a rider being sent back to a
   * via point they have already gone through.
   */
  const rerouteFrom = useCallback(
    async (
      from: { lon: number; lat: number },
      remaining: { lon: number; lat: number }[],
      profileId: string,
    ): Promise<boolean> => {
      if (remaining.length === 0) return false
      const next: Waypoint[] = [
        { id: crypto.randomUUID(), lon: from.lon, lat: from.lat },
        ...remaining.map((w) => ({ id: crypto.randomUUID(), lon: w.lon, lat: w.lat })),
      ]
      const lonLats = next.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|')

      setRouting(profileId)
      setError(null)
      try {
        const outcome = await sharedEngine().route(profileId, lonLats)
        if (!outcome.ok || !outcome.gpx) {
          setError(explainRoutingFailure(outcome.error ?? 'routing failed', next))
          return false
        }
        const parsed = parseBrouterGpx(outcome.gpx)
        setWaypoints(next)
        setRoutes({ [profileId]: parsed })
        setGpx({ [profileId]: outcome.gpx })
        setChosen(profileId)
        return true
      } catch (e) {
        // `route()` reports a routing failure by returning, but the *call* can still reject —
        // a worker that failed to spawn, an engine that could not initialise. Uncaught, that
        // skipped `setRouting(null)` and pinned the spinner: mid-ride the Reroute button would
        // read "Routing…" for the rest of the ride with no way to clear it.
        setError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setRouting(null)
      }
    },
    [],
  )

  /**
   * Turns the plan round and routes it the other way.
   *
   * Not just `waypoints.reverse()` and keep the line. A cycle route is **not symmetric**: one-way
   * streets, no-entry turns and BRouter's own cost model all mean the way home is a different
   * road from the way out, sometimes substantially. Reversing the drawn geometry would put a
   * line on the map that the rider cannot legally follow, so the reversed plan is routed again.
   *
   * Reuses `run`'s selection, which is the right behaviour on the planning screen: if you were
   * comparing three styles on the way out, you want the same three on the way back.
   */
  const reverse = useCallback(() => {
    setWaypoints((current) => [...current].reverse())
    setRoutes({})
    setGpx({})
    setChosen(null)
    setError(null)
  }, [])

  /**
   * Puts a saved route back on the map, exactly as it was computed.
   *
   * The stored GPX is re-parsed rather than a stored geometry being trusted, so a saved route
   * goes through the same `parseBrouterGpx` that every freshly computed one does — one code
   * path, and the GPX parity corpus covers it.
   *
   * The selection collapses to the saved profile. A loaded route is a decision already made,
   * and leaving a six-way comparison ticked would mean the next Reroute silently recomputed
   * six routes.
   */
  const loadSaved = useCallback(
    (entry: { waypoints: Waypoint[]; profile: string; gpx: string }): boolean => {
      try {
        const parsed = parseBrouterGpx(entry.gpx)
        setWaypoints(entry.waypoints)
        setSelection([entry.profile])
        setRoutes({ [entry.profile]: parsed })
        setGpx({ [entry.profile]: entry.gpx })
        setChosen(entry.profile)
        setError(null)
        return true
      } catch (e) {
        setError(`That saved route could not be read: ${e instanceof Error ? e.message : e}`)
        return false
      }
    },
    [],
  )

  /** Kills the worker mid-route. See `engineClient.cancel` for why it has to be this blunt. */
  const cancel = useCallback(() => {
    sharedEngine().cancel()
    setRouting(null)
    setError('Cancelled.')
  }, [])

  return {
    waypoints,
    selection,
    /** The profile the rider committed to, or `null` while a comparison is open. */
    chosen,
    routes,
    gpx,
    /** The chosen route, if one has been chosen. What the rail and the detail view describe. */
    route: chosen ? routes[chosen] ?? null : null,
    chosenGpx: chosen ? gpx[chosen] ?? null : null,
    routing,
    error,
    warning: longRouteWarning(waypoints, selection.length),
    chooseProfile,
    clearChoice,
    /**
     * Whether a choice exists that is worth reverting. A lone route is not a comparison:
     * there is nothing to go back to, and clearing would only disable Start.
     */
    clearableChoice: chosen !== null && Object.keys(routes).length > 1,
    toggleProfile,
    addWaypoint,
    moveWaypoint,
    removeWaypoint,
    clear,
    run,
    rerouteFrom,
    reverse,
    loadSaved,
    cancel,
    setError,
  }
}

export type Plan = ReturnType<typeof useRoute>

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
