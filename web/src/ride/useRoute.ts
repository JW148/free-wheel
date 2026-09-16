import { useCallback, useEffect, useRef, useState } from 'react'
import { sharedEngine } from '../engine/engineClient'
import { tilesForWaypoints } from '../engine/tiles'
import { haversineM } from './geo'
import { parseBrouterGpx, parseTrackGpx, type ParsedRoute } from './gpx'
import {
  chosenAfterRun,
  loadPlan,
  savePlan,
  withEndpoint,
  type PlanSlot,
  type StoredPlan,
  type Waypoint,
} from './plan'
import { DEFAULT_PROFILES, isRoutableProfile, RECORDED_TRACK, type ProfileId } from './profiles'
import { stitchRoute, stitchedGpx, type RiddenPrefix } from './stitch'

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
 * Air distance beyond which three routes is too many to compute without being asked.
 *
 * The second tap now produces three routes rather than one, and the Worker blocks inside Wasm
 * for each of them in turn — so the wait is three times what it was. At a third of
 * {@link AIR_DISTANCE_CEILING_M} that is still a few seconds; past it, it is a rider watching
 * a spinner for something they did not ask for. Above this only the rider's own style runs,
 * and the other two cards offer themselves.
 *
 * The two constants measure different things and are deliberately not the same number:
 * `AIR_DISTANCE_CEILING_M` is where *one* route gets uncomfortable, this is where *three* do.
 */
export const COMPARE_CEILING_M = 50_000

/** Straight-line length of a leg sequence, which is what both ceilings are measured against. */
export function airDistanceM(points: { lon: number; lat: number }[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += haversineM([points[i - 1].lon, points[i - 1].lat], [points[i].lon, points[i].lat])
  }
  return total
}

/**
 * Which profiles a run should actually compute, and whether that is all of them.
 *
 * Pure so the ceiling can be tested at either side of itself without a Worker. `preferred`
 * leads the list either way: it is the rider's own style, so it is the one whose result is
 * worth having first even when all three are coming.
 */
export function profilesToRun(
  selection: string[],
  preferred: string,
  airM: number,
): { run: string[]; deferred: string[] } {
  const ordered = [preferred, ...selection.filter((id) => id !== preferred)].filter((id) =>
    selection.includes(id),
  )
  if (ordered.length <= 1 || airM < COMPARE_CEILING_M) return { run: ordered, deferred: [] }
  return { run: ordered.slice(0, 1), deferred: ordered.slice(1) }
}

/**
 * The plan: waypoints, which profiles to route them with, and which result the rider picked.
 *
 * `chosen` is the load-bearing piece. It is `null` while a comparison is open, and only a
 * rider's tap — on a line on the map, or on a row in the sheet — fills it in. Everything
 * downstream keys off that: the stats rail, the elevation profile, whether Start is offered,
 * and which line is drawn thick. The one exception is a run that returns a single route,
 * where there is nothing to weigh and committing saves a pointless tap.
 */
export function useRoute(preferred: ProfileId = DEFAULT_PROFILES[0]) {
  const restored = useRef<StoredPlan | null>(null)
  restored.current ??= loadPlan()
  // `run` needs it and must not be rebuilt when it changes: a new `run` identity on every
  // rider edit would re-fire every effect that depends on it, mid-ride included.
  const preferredRef = useRef(preferred)
  preferredRef.current = preferred

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
        // The key says which document this is. A recorded track has no `track-length` summary,
        // so reading it with the engine's parser restores a route of zero length — and a
        // progress bar that divides by it. See `parseTrackGpx`.
        parsed[id] = id === RECORDED_TRACK.id ? parseTrackGpx(doc) : parseBrouterGpx(doc)
      } catch {
        // Drop an unparseable stored route rather than refusing to start.
      }
    }
    return parsed
  })
  const [routing, setRouting] = useState<string | null>(null)
  /**
   * Profiles a run declined to compute because the route was too long to do three of.
   *
   * Not an error and not a failure — the cards are still offered, they just say so and route
   * when tapped. Held in state rather than derived, because it has to survive the rider
   * choosing one of the routes that *did* compute.
   */
  const [deferred, setDeferred] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /**
   * A route was asked for by something that had to change the waypoints first.
   *
   * Consumed by an effect, because `run` is built from the *current* `waypoints` and a caller
   * that has just replaced them is holding the previous one. See {@link placeAt}.
   */
  const [runWanted, setRunWanted] = useState(false)

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
    setDeferred([])
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

  /**
   * Computes the routes on offer.
   *
   * Three things changed when the tick-list became three cards, and all three are about what
   * the rider sees while they wait:
   *
   * - **Results land one at a time.** The Worker routes sequentially — it blocks inside Wasm,
   *   so issuing them together only queues them — and each result is now committed to state
   *   as it arrives rather than all of them at the end. The first card fills in while the
   *   second is still computing, which is the difference between a list assembling itself and
   *   a spinner.
   * - **The rider's own style goes first**, so the card most likely to be chosen is the one
   *   that is ready first.
   * - **A long route defers the other two** rather than making the rider wait for three
   *   searches they did not ask for. See {@link COMPARE_CEILING_M}.
   *
   * `only` runs a single profile without disturbing the rest, which is what a deferred card's
   * own tap does.
   */
  const run = useCallback(
    async (only?: string) => {
      if (waypoints.length < 2) {
        setError('Tap the map to set a start and a finish.')
        return
      }
      setError(null)
      const lonLats = waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|')

      const { run: ids, deferred } = only
        ? { run: [only], deferred: [] }
        : profilesToRun(selection, preferredRef.current, airDistanceM(waypoints))

      // A fresh run replaces what was on the map; a single deferred profile joins it.
      if (!only) {
        setChosen(null)
        setRoutes({})
        setGpx({})
      }
      setDeferred(deferred)

      const computed: string[] = []
      const failures: string[] = []

      try {
        for (const id of ids) {
          setRouting(id)
          const outcome = await sharedEngine().route(id, lonLats)
          if (!outcome.ok || !outcome.gpx) {
            failures.push(explainRoutingFailure(outcome.error ?? 'routing failed', waypoints))
            continue
          }
          try {
            const parsed = parseBrouterGpx(outcome.gpx)
            setRoutes((current) => ({ ...current, [id]: parsed }))
            setGpx((current) => ({ ...current, [id]: outcome.gpx! }))
            // A profile computed on demand joins the comparison. It is on the map now, so a
            // selection that did not contain it would let "More riding styles" collapse over a
            // line the rider can still see — and would drop it on the next reroute.
            setSelection((current) => (current.includes(id) ? current : [...current, id]))
            computed.push(id)
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

      // A lone result is not a choice, so it commits itself. Deferred profiles do not count as
      // alternatives for this: they are not on the map, and there is nothing to weigh.
      if (!only) setChosen(chosenAfterRun(computed))

      // A partial comparison is still useful — say what failed rather than discarding the rest.
      if (failures.length) setError([...new Set(failures)].join(' '))
    },
    [waypoints, selection],
  )

  /**
   * Routes again from where the rider is now, and joins it onto the ride they have already done.
   *
   * Mid-ride, and so deliberately unlike {@link run} in four ways:
   *
   * - **One profile.** The comparison is over — the rider is on a road, committed. Routing six
   *   profiles one after another would take six times as long at the moment it matters most.
   * - **Only the road ahead is computed.** The engine is asked for the rider's position through
   *   to the finish, which is the only part that is still a question.
   * - **The journey is kept.** What comes back is *stitched* onto the part already ridden, and
   *   the plan keeps its original start and every via already passed, with the rider's position
   *   added as one more point along the way. Replacing the route instead — which is what this
   *   used to do — resets the trip length, the progress bar and the climbing done, all at once,
   *   in the middle of a ride where nothing has actually changed except a wrong turn. See
   *   `stitch.ts`.
   * - **A failure changes nothing.** The old route stays on the map and the rider keeps
   *   whatever they had. The alternative — clearing the route because the reroute failed — is
   *   the worst possible response to being lost.
   *
   * `behind` and `remaining` come from `splitWaypoints`, which is one function precisely so the
   * two halves cannot disagree and send a rider back through a via point they have gone past.
   * `prefix` is `null` when there is nothing to stitch to — no geometry, no progress — and then
   * this behaves as it always did.
   */
  const rerouteFrom = useCallback(
    async ({
      from,
      behind,
      remaining,
      profileId,
      prefix,
    }: {
      from: { lon: number; lat: number }
      behind: Waypoint[]
      remaining: Waypoint[]
      profileId: string
      prefix: RiddenPrefix | null
    }): Promise<boolean> => {
      if (remaining.length === 0) return false
      const here: Waypoint = {
        id: crypto.randomUUID(),
        lon: from.lon,
        lat: from.lat,
        kind: 'reroute',
      }
      const leg = [here, ...remaining]
      const next: Waypoint[] = [...behind, ...leg]
      // Only the leg goes to the engine. `behind` is road that has already happened, and asking
      // for it again would both cost a search the rider is waiting on and risk coming back with
      // a different answer for a ride they have already done.
      const lonLats = leg.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|')

      setRouting(profileId)
      setError(null)
      try {
        const outcome = await sharedEngine().route(profileId, lonLats)
        if (!outcome.ok || !outcome.gpx) {
          setError(explainRoutingFailure(outcome.error ?? 'routing failed', leg))
          return false
        }
        const fresh = parseBrouterGpx(outcome.gpx)
        const joined = prefix ? stitchRoute(prefix, fresh) : fresh
        setWaypoints(next)
        setRoutes({ [profileId]: joined })
        // The document has to describe the same line the map is drawing, or Save and Export
        // hand back the tail of a ride rather than the ride.
        setGpx({
          [profileId]: prefix ? stitchedGpx(joined, `free-wheel_${profileId}`) : outcome.gpx,
        })
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
    setDeferred([])
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

  /**
   * Puts a *recorded* ride back on the map as the line to follow.
   *
   * Deliberately different from {@link loadSaved} in three ways, all of which follow from a
   * track being something that happened rather than something the engine computed:
   *
   * - **It is drawn as `recorded`, not as a profile.** No profile produced it, and labelling it
   *   with one would claim a routing style it never had.
   * - **The selection is left alone.** It is what "Find route" and an automatic reroute will
   *   use, and a recorded track cannot route — so the rider keeps whatever style they had.
   * - **The waypoints become its two ends.** They are what a reroute routes *to*: come off the
   *   track and the app takes you on to where the track finished, which is the only useful
   *   answer. The middle of the track is not waypoints — it is the road.
   */
  const loadTrack = useCallback((entry: { gpx: string }): boolean => {
    try {
      const parsed = parseTrackGpx(entry.gpx)
      const start = parsed.coords[0]
      const finish = parsed.coords[parsed.coords.length - 1]
      setWaypoints([
        { id: crypto.randomUUID(), lon: start[0], lat: start[1] },
        { id: crypto.randomUUID(), lon: finish[0], lat: finish[1] },
      ])
      setRoutes({ [RECORDED_TRACK.id]: parsed })
      setGpx({ [RECORDED_TRACK.id]: entry.gpx })
      setChosen(RECORDED_TRACK.id)
      setError(null)
      return true
    } catch (e) {
      setError(`That recorded ride could not be read: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }, [])

  /**
   * Puts a searched place at one end of the plan, and routes it once both ends exist.
   *
   * The routing is deferred to an effect rather than done here, and that is the whole of the
   * fiddliness: `run` closes over `waypoints`, so calling it in the same tick as `setWaypoints`
   * would route the plan as it was a moment ago — which for a rider who has just chosen a
   * destination is a route to their previous one. The flag below is set here and consumed after
   * the state has committed, by which time `run` is the one that knows about the new plan.
   *
   * Routes are cleared either way. A line on the map computed for a start the rider has just
   * replaced is not a stale figure, it is a wrong one.
   */
  const placeAt = useCallback(
    (slot: PlanSlot, point: { lon: number; lat: number; label?: string }) => {
      const next = withEndpoint(waypoints, slot, point)
      setWaypoints(next)
      setRoutes({})
      setGpx({})
      setChosen(null)
      setDeferred([])
      setError(null)
      setRunWanted(next.length >= 2)
    },
    [waypoints],
  )

  /** Kills the worker mid-route. See `engineClient.cancel` for why it has to be this blunt. */
  const cancel = useCallback(() => {
    sharedEngine().cancel()
    setRouting(null)
    setError('Cancelled.')
  }, [])

  useEffect(() => {
    if (!runWanted) return
    setRunWanted(false)
    if (waypoints.length >= 2) void run()
  }, [runWanted, waypoints, run])

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
    /** Profiles the run deferred. Their cards offer to compute themselves. */
    deferred,
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
    placeAt,
    moveWaypoint,
    removeWaypoint,
    clear,
    run,
    rerouteFrom,
    reverse,
    loadSaved,
    loadTrack,
    /**
     * The profile a reroute should use.
     *
     * Not simply `chosen`: following a recorded track sets `chosen` to `recorded`, which names
     * no `.brf` file, so a reroute would ask the engine for a profile that does not exist and
     * come back with a routing failure at the exact moment the rider is lost. The ticked
     * selection is the honest fallback — it is the style this rider rides.
     */
    rerouteProfile: isRoutableProfile(chosen) ? chosen! : selection[0],
    /** Whether what is on the map is a track that was ridden rather than a computed route. */
    isRecordedTrack: chosen === RECORDED_TRACK.id,
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
  const total = airDistanceM(waypoints)
  if (total < AIR_DISTANCE_CEILING_M) return null
  const each = profileCount > 1 ? ` — and you are comparing ${profileCount} profiles, one after another` : ''
  return `That is ${Math.round(total / 1000)} km as the crow flies. Routing cost grows roughly with the square of distance${each}, so this may take a while or time out.`
}
