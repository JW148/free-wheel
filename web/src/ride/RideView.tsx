import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Marker, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { useMapLibre } from './useMapLibre'
import { useRoute } from './useRoute'
import { useGeolocation } from './useGeolocation'
import { useWakeLock } from './useWakeLock'
import { useHeading } from './useHeading'
import { useRideTelemetry } from './useRideTelemetry'
import { useAnnouncer } from './useAnnouncer'
import type { Rider } from './useRider'
import { sliceAlong, splitWaypoints } from './progress'
import { riddenPrefix } from './stitch'
import {
  boundsOf,
  drawnRoutes,
  mapTapAction,
  routeAt,
  setFocus,
  setPosition,
  setPositionEmphasis,
  setRoutes,
  setTravelled,
} from './routeLayers'
import { formatAway } from './format'
import RouteSheet from './RouteSheet'
import LayersSheet from './LayersSheet'
import SavedScreen from '../library/SavedScreen'
import RideHud from './RideHud'
import RideSummarySheet from './RideSummary'
import { useRouteSheet } from './useRouteSheet'
import SearchScreen from '../search/SearchScreen'
import { places } from '../search/searchStore'
import { waypointRows, type PlanSlot } from './plan'

/** How close the map sits to the rider once a ride starts. Street-level, not overview. */
const RIDING_ZOOM = 16.5

const HUD_KEY = 'free-wheel.hud.v1'
const COURSE_UP_KEY = 'free-wheel.courseup.v1'
const VOICE_KEY = 'free-wheel.voice.v1'

/**
 * How long after a pan the camera goes back to following.
 *
 * A rider who drags the map is asking a question — what is over there, where does this road
 * go — and the answer takes a few seconds to read. Snapping back on the next fix makes the
 * gesture impossible; never coming back means one accidental brush of the screen leaves the
 * map stranded for the rest of the ride. Twelve seconds is long enough to look and short
 * enough that it is forgiving.
 */
const FOLLOW_RESUME_MS = 12_000

/**
 * The minimum gap between automatic reroutes.
 *
 * Routing on a phone costs seconds and battery, and a rider on a parallel cycle path can be
 * "off route" for a long time. Without a floor, the app would recompute continuously and the
 * route would flicker between two answers. A manual tap on Reroute bypasses this: that is an
 * explicit request, and refusing it would be inexplicable.
 */
const REROUTE_COOLDOWN_MS = 45_000

/** One button on the floating rail. `pressed` is set only where the state is truly binary. */
type RailControl = {
  key: string
  icon: React.ReactNode
  label: string
  active?: boolean
  pressed?: boolean
  onClick: () => void
}

/**
 * The ride screen: a full-bleed map with controls floating over it.
 *
 * It has two modes, and they want opposite things:
 *
 * - **Planning** — tap to place points, compare styles, read an elevation profile, save a
 *   route. Chrome is welcome; you are sitting still and looking at the screen.
 * - **Riding** — one glance, at speed, one-handed. Everything not needed for the next
 *   junction gets out of the way, the camera locks to the rider, and tapping the map no
 *   longer places a waypoint — a bump in the road should not edit the route.
 *
 * Riding mode now also *knows where you are on the route*, which is what `useRideTelemetry`
 * exists for: progress, the climb ahead, an estimated power figure, whether you have come off
 * the line, and a recording of what actually happened.
 */
export default function RideView({
  container,
  basemap,
  suspended,
  rider,
  onOpenSetup,
}: {
  container: React.RefObject<HTMLDivElement | null>
  basemap: ReturnType<typeof useMapLibre>
  /**
   * Whether another screen currently owns the map.
   *
   * There is one MapLibre instance for the whole app — `App.tsx` owns the controller and
   * hands it to both screens — so while the region picker is up, the map it draws Britain on
   * is this one. Every effect below that *writes* to the map or *listens* to it is gated on
   * this, and gated by not running at all rather than by running and ignoring itself: the
   * tap handler is never registered, the pins are never added, the camera is never fitted.
   *
   * The ride screen's chrome is hidden by CSS in the same situation, and that is not the same
   * guarantee. Markers and handlers live on the map instance, inside `.ride-map`, which is a
   * sibling of the element that rule hides.
   */
  suspended: boolean
  rider: Rider
  onOpenSetup: (page?: 'maps' | 'rider') => void
}) {
  const {
    map,
    active: activeBasemap,
    error: mapError,
    status: mapStatus,
    styleReady,
    workerProblem,
    theme,
    setTheme,
    pathMode,
    setPathMode,
  } = basemap
  const plan = useRoute(rider.setup.style)
  const sheet = useRouteSheet(plan)
  const [riding, setRiding] = useState(false)
  /**
   * Whether the map sheet of layers is open, and whether the saved list is.
   *
   * Both are full surfaces over the map rather than rail buttons. See `LayersSheet`.
   */
  const [layersOpen, setLayersOpen] = useState(false)
  const [savedOpen, setSavedOpen] = useState(false)
  /**
   * Which end of the plan the search screen is choosing, or `null` when it is closed.
   *
   * A slot rather than a boolean, because the screen is opened from three places that mean
   * three different things — the field at the top of the map, the start row, the finish row.
   */
  const [searching, setSearching] = useState<PlanSlot | null>(null)
  /**
   * The next tap on the map replaces this end of the plan rather than appending a point.
   *
   * The app's oldest rule is that a tap always places a waypoint, because a mode you can be in
   * without knowing is how a rider ends up tapping a map that has stopped responding. This is a
   * mode, so it is allowed only with a strip on screen saying so and a Cancel beside it — and it
   * ends on the first tap either way.
   */
  const [aiming, setAiming] = useState<PlanSlot | null>(null)
  /** Bumped after a save, so the Saved list picks the new entry up when it next opens. */
  const [librarySaves, setLibrarySaves] = useState(0)
  const [follow, setFollow] = useState(false)
  /**
   * Whether the map turns to face the way the rider is going.
   *
   * Off by default, and remembered. North-up is what the planning screen wants and what half
   * of riders want on the road too — a rotating map is genuinely disorienting to some people,
   * and the basemap's own labels are laid out for north-up. So it is a choice, not a mode the
   * app assumes.
   */
  const [courseUp, setCourseUp] = useState(() => {
    try {
      return localStorage.getItem(COURSE_UP_KEY) === 'on'
    } catch {
      return false
    }
  })
  /**
   * Whether the HUD is showing the elevation graph.
   *
   * Remembered, like the rail and the theme, and for the same reason: a rider who folded the
   * panel away wants it folded away on the next ride too. The chevron that brings it back
   * never leaves the panel, so there is no state this can get stuck in.
   */
  const [hudExpanded, setHudExpanded] = useState(() => {
    try {
      return localStorage.getItem(HUD_KEY) !== 'mini'
    } catch {
      return true
    }
  })
  /**
   * Whether the app speaks the climb ahead.
   *
   * On by default, which is a deliberate choice rather than an oversight. A muted feature is a
   * feature nobody finds, and this one only ever speaks *after* the rider has tapped Start —
   * where the very first thing it says is "Ride started", so the connection between the tap
   * and the voice is immediate and the mute button is on the same screen.
   */
  const [voice, setVoice] = useState(() => {
    try {
      return localStorage.getItem(VOICE_KEY) !== 'off'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(COURSE_UP_KEY, courseUp ? 'on' : 'off')
      localStorage.setItem(VOICE_KEY, voice ? 'on' : 'off')
      localStorage.setItem(HUD_KEY, hudExpanded ? 'full' : 'mini')
    } catch {
      /* Private mode. The rail just opens expanded next launch. */
    }
  }, [courseUp, voice, hudExpanded])

  // Riding implies following, and implies not editing.
  const following = riding || follow
  const { fix, status: fixStatus, error: fixError, locateOnce } = useGeolocation(following)
  const wakeLock = useWakeLock(riding)
  const heading = useHeading(following, fix?.heading ?? null)
  const telemetry = useRideTelemetry({ riding, route: plan.route, fix, rider: rider.setup })

  /**
   * Bumped whenever the route is replaced, so cues about the old route cannot suppress the
   * same cue about the new one — "off route" has to be sayable again after a reroute.
   */
  const [routeVersion, setRouteVersion] = useState(0)
  useEffect(() => setRouteVersion((v) => v + 1), [telemetry.geometry])

  const cueInput = useMemo(
    () =>
      riding && telemetry.progress
        ? {
            alongM: telemetry.progress.position.alongM,
            remainingM: telemetry.progress.remainingM,
            climbs: telemetry.climbs,
            offRoute: telemetry.offRoute,
            offRouteSince: telemetry.offRouteSince,
            routeVersion,
          }
        : null,
    [
      riding,
      telemetry.progress,
      telemetry.climbs,
      telemetry.offRoute,
      telemetry.offRouteSince,
      routeVersion,
    ],
  )
  // `riding` is the session: muting is not the end of a ride, and forgetting what has been
  // said because someone hit mute means un-muting replays it all.
  const announcer = useAnnouncer(riding && voice, cueInput, riding)

  /** Set by a pan, cleared by the timer or by Recentre. See {@link FOLLOW_RESUME_MS}. */
  const [followPaused, setFollowPaused] = useState(false)
  const [rerouting, setRerouting] = useState(false)
  const lastRerouteAt = useRef(0)

  const markers = useRef(new Map<string, Marker>())
  const addWaypoint = useRef(plan.addWaypoint)
  addWaypoint.current = plan.addWaypoint
  const moveWaypoint = useRef(plan.moveWaypoint)
  moveWaypoint.current = plan.moveWaypoint
  const removeWaypoint = useRef(plan.removeWaypoint)
  removeWaypoint.current = plan.removeWaypoint
  const chooseRoute = useRef(sheet.choose)
  chooseRoute.current = sheet.choose
  const clearChoice = useRef(plan.clearChoice)
  clearChoice.current = plan.clearChoice
  // Choosing is a planning act. Mid-ride the decision is made, and a bump in the road that
  // lands a tap on the line must not throw the drawer over the map being navigated by.
  const canChoose = useRef(true)
  canChoose.current = !riding
  const clearable = useRef(false)
  clearable.current = plan.clearableChoice
  // Read from the tap handler, which is registered once: a clear is a tap on the chosen line,
  // so the handler has to know which line that is without being rebuilt when it changes.
  const chosenNow = useRef<string | null>(null)
  chosenNow.current = plan.chosen
  /*
   * A tap on the map places a waypoint whenever the rider is planning.
   *
   * There used to be a pin button arming this, on the theory that a stray tap adding a seventh
   * waypoint was worse than an extra button. It was not: the plan card now names every point
   * and gives each one an explicit ×, so an accidental tap is one tap to undo and visible the
   * moment it happens — while the toggle was a mode you could be in without knowing, which is
   * how a rider ends up tapping a map that has stopped responding.
   *
   * Riding still refuses taps entirely. That guarantee is the one worth keeping: a bump in the
   * road must not edit the route being followed.
   */
  const editable = !riding
  const canPlace = useRef(editable)
  canPlace.current = editable
  // Read from the tap handler, which is registered once and must not be rebuilt when the mode
  // changes — re-registering a map listener per render is how a tap gets handled twice.
  const aimingAt = useRef<PlanSlot | null>(null)
  aimingAt.current = aiming
  const placeAt = useRef(plan.placeAt)
  placeAt.current = plan.placeAt
  const stopAiming = useRef<() => void>(() => {})
  stopAiming.current = () => setAiming(null)
  const closeSheet = useRef<() => void>(() => {})
  closeSheet.current = () => sheet.setOpen(false)
  // Read from callbacks that must not be rebuilt on every render — a reroute reads the plan,
  // the fix and the telemetry, all three of which change once a second.
  const live = useRef({ plan, fix, telemetry })
  live.current = { plan, fix, telemetry }

  // ── Tap to choose a route, clear a choice, or place a waypoint ─────────────────────────
  // Three intents, one gesture. `mapTapAction` owns the precedence and is tested directly.
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || suspended) return
    const onClick = (e: MapMouseEvent) => {
      const action = mapTapAction({
        // Always false by the time this runs — the effect does not register the handler
        // otherwise — but passed rather than hardcoded, so the rule lives in one place and
        // the closure cannot go stale against it.
        suspended,
        profileUnderTap: canChoose.current ? routeAt(instance, e.point) : null,
        choosing: canChoose.current,
        clearableChoice: clearable.current,
        chosen: chosenNow.current,
        placing: canPlace.current,
      })
      if (action.do === 'choose') chooseRoute.current(action.profile)
      else if (action.do === 'clear') clearChoice.current()
      else if (action.do === 'place') {
        // "Choose on the map" armed a slot: this tap *replaces* that end rather than adding a
        // seventh point. It disarms either way, so the mode cannot outlive the tap it was for.
        const slot = aimingAt.current
        if (slot) {
          placeAt.current(slot, { lon: e.lngLat.lng, lat: e.lngLat.lat })
          stopAiming.current()
        } else {
          addWaypoint.current(e.lngLat.lng, e.lngLat.lat)
        }
      }
    }
    instance.on('click', onClick)
    return () => {
      instance.off('click', onClick)
    }
  }, [map, styleReady, suspended])

  /**
   * The second point opens the sheet onto the cards.
   *
   * The *routing* is `useRoute`'s now — see `addWaypoint` and `placeAt` — because two different
   * gestures put a second point on a plan and a transition guard here cannot tell a tap from a
   * search result, so both fired and the Worker searched the same route twice. What is left is
   * the half that is genuinely the screen's: a result the rider has to go looking for is a
   * result they will not know arrived.
   */
  const lastPointCount = useRef(plan.waypoints.length)
  useEffect(() => {
    const was = lastPointCount.current
    lastPointCount.current = plan.waypoints.length
    if (was !== 1 || plan.waypoints.length !== 2) return
    if (riding || suspended) return
    sheet.showCompare()
    // `sheet` is rebuilt on every render; the transition guard above is what makes this fire
    // once rather than continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.waypoints.length])

  // ── Panning pauses following ──────────────────────────────────────────────────────────
  // Only a *user* drag: `originalEvent` is absent on the programmatic `easeTo` that follow
  // mode itself issues, and without that check following would cancel itself on the first fix.
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || suspended) return
    const onDrag = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) setFollowPaused(true)
    }
    instance.on('dragstart', onDrag)
    return () => {
      instance.off('dragstart', onDrag)
    }
  }, [map, styleReady, suspended])

  useEffect(() => {
    if (!followPaused) return
    const id = setTimeout(() => setFollowPaused(false), FOLLOW_RESUME_MS)
    return () => clearTimeout(id)
  }, [followPaused])

  // ── Waypoint pins ─────────────────────────────────────────────────────────────────────
  // DOM markers rather than a symbol layer: they need to be individually draggable and
  // tappable, which is fiddly with a layer and free with a Marker. They also survive a
  // `setStyle` for the theme swap, which layers do not.
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return

    // A pin is map content, not chrome, so no CSS rule takes it off a map the picker is
    // drawing Britain on. Any that were already placed come off — a plan saved before the
    // app was updated must not reappear as stray letters over a region list.
    if (suspended) {
      for (const [, marker] of markers.current) marker.remove()
      markers.current.clear()
      return
    }

    const live = new Set(plan.waypoints.map((w) => w.id))
    for (const [id, marker] of markers.current) {
      if (!live.has(id)) {
        marker.remove()
        markers.current.delete(id)
      }
    }

    // Numbering counts only the points the rider placed, and the rule lives in `waypointRows`
    // because the plan card and the sheet's list both draw it too — see its doc comment for
    // why a rejoin is named rather than counted.
    const rows = waypointRows(plan.waypoints)
    plan.waypoints.forEach((waypoint, index) => {
      const { role, badge: label, word } = rows[index]
      const rejoin = role === 'rejoin'

      let marker = markers.current.get(waypoint.id)
      if (!marker) {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'pin'
        // Through a ref, like the others: this listener is attached once per marker and
        // would otherwise capture the first render's callback for the marker's whole life.
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          if (canPlace.current) removeWaypoint.current(waypoint.id)
        })
        marker = new Marker({ element, draggable: true, anchor: 'center' })
          .setLngLat([waypoint.lon, waypoint.lat])
          .addTo(instance)
        marker.on('dragend', () => {
          const { lng, lat } = marker!.getLngLat()
          moveWaypoint.current(waypoint.id, lng, lat)
        })
        markers.current.set(waypoint.id, marker)
      } else {
        marker.setLngLat([waypoint.lon, waypoint.lat])
      }

      // Dragging a pin off course mid-ride would be an accident, never an intention.
      marker.setDraggable(editable)
      const element = marker.getElement()
      element.dataset.role = role
      element.dataset.editable = editable ? 'yes' : 'no'
      element.textContent = label
      const described = rejoin ? 'the point you rejoined the route at' : word
      element.setAttribute(
        'aria-label',
        editable ? `${described}. Tap to remove.` : described,
      )
    })
  }, [map, styleReady, suspended, plan.waypoints, editable])

  // ── The routes ────────────────────────────────────────────────────────────────────────
  const lastFitted = useRef<string | null>(null)
  useEffect(() => {
    const instance = map.current
    // `setRoutes` is harmless on the picker's backdrop — `showRemote` never adds the route
    // source, so it no-ops — but `fitBounds` below is not: a plan saved from an earlier
    // session would yank the picker's camera off Britain and onto last week's ride.
    if (!instance || !styleReady || suspended) return

    // While riding, the comparison is over: only the route being ridden is drawn, and it is
    // drawn as a lone route — neutral near-white, maximum contrast for a glance at speed. The
    // rejected routes stay in state, so ending the ride puts the comparison back.
    const chosenRoute = plan.chosen ? plan.routes[plan.chosen] : undefined
    const visible =
      riding && plan.chosen && chosenRoute ? { [plan.chosen]: chosenRoute } : plan.routes
    const ids = Object.keys(visible)
    // Never dimmed while riding. Off the bike a faded line means "a better answer is coming";
    // on the bike it is still the road the rider is being asked to follow, and a reroute is
    // exactly the moment they are looking hardest at it.
    const drawn = drawnRoutes(visible, plan.chosen, plan.stale && !riding)
    setRoutes(instance, drawn)

    /*
     * Fit only when the *set* of routes changes or the journey is replaced wholesale, and never
     * while riding — the camera belongs to the rider then, and being yanked out to an overview
     * mid-junction is the opposite of helpful.
     *
     * Deliberately not the waypoint count, which is what this used to key on. Shaping a route
     * is a run of taps on a map the rider is looking at, and re-framing after each one moves
     * the ground out from under the next tap: they zoom in, tap, get pulled back out to the
     * overview, and zoom in again. `plan.framing` is the honest signal — see `useRoute`.
     */
    const signature = [...ids].sort().join(',') + '|' + plan.framing
    if (!riding && drawn.length > 0 && signature !== lastFitted.current) {
      lastFitted.current = signature
      const bounds = boundsOf(drawn.flatMap((r) => r.coords))
      if (bounds) {
        instance.fitBounds(bounds, { padding: { top: 110, bottom: 190, left: 45, right: 45 } })
      }
    }
    if (drawn.length === 0) lastFitted.current = null
  }, [map, styleReady, suspended, plan.routes, plan.chosen, plan.stale, plan.framing, riding])

  // ── Progress and the climb ahead, on the map ──────────────────────────────────────────
  // Quantised to 25 m so the two GeoJSON sources are not rebuilt on every fix. At 25 km/h that
  // is about three updates a second at worst, and the overlay creeps rather than jumps.
  const travelledM =
    telemetry.progress === null ? null : Math.round(telemetry.progress.position.alongM / 25) * 25
  const climbSpan = telemetry.ahead
    ? `${telemetry.ahead.gradient.startM}:${telemetry.ahead.gradient.endM}`
    : null
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || suspended) return
    const geometry = telemetry.geometry
    if (!riding || !geometry || travelledM === null) {
      setTravelled(instance, [])
      setFocus(instance, [])
      return
    }
    setTravelled(instance, sliceAlong(geometry, 0, travelledM))
    const climb = telemetry.ahead
    setFocus(
      instance,
      climb ? sliceAlong(geometry, climb.gradient.startM, climb.gradient.endM) : [],
    )
    // `telemetry.ahead` is deliberately reduced to `climbSpan`: the object is rebuilt on every
    // fix as the remaining distance ticks down, but the *stretch being highlighted* only
    // changes when the climb does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleReady, suspended, riding, telemetry.geometry, travelledM, climbSpan])

  // ── The camera ────────────────────────────────────────────────────────────────────────
  /**
   * One effect, and it has to be one.
   *
   * Recentring and rotating were two effects, both listing `heading.heading` in their
   * dependencies, so both ran in the same commit. `easeTo` calls `stop()` on whatever
   * animation is in flight and defaults its target centre to the map's *current* centre — so
   * the rotation cancelled the recentre before its first frame, and with course-up on the map
   * turned to face the right way and then never followed the rider. `centreOnMe` lost its ease
   * to the same collision.
   *
   * The bearing goes back to north when course-up is off or the ride has ended — but
   * deliberately **not** while following is merely paused. Panning to look at what is up ahead
   * should not spin the map to north-up under your thumb and then spin it back twelve seconds
   * later.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || suspended) return

    // The arrow is drawn only while following. On the planning screen a heading arrow implies
    // a live orientation the rider is not being given, and the plain dot says "you are here"
    // without claiming to know which way you face.
    if (fix) setPosition(instance, fix.lon, fix.lat, following ? heading.heading : null)

    const locked = following && !followPaused
    const turning = locked && courseUp && heading.heading !== null
    const northUp = !courseUp || !following

    // MapLibre 6 normalises a target bearing against the current one (`_normalizeBearing`), so
    // it already turns the short way round; nothing here has to do that arithmetic.
    const bearing = turning
      ? heading.heading!
      : northUp && instance.getBearing() !== 0
        ? 0
        : null

    if (locked && fix) {
      instance.easeTo({
        center: [fix.lon, fix.lat],
        ...(bearing === null ? {} : { bearing }),
        duration: 700,
      })
    } else if (bearing !== null) {
      instance.easeTo({ bearing, duration: 400 })
    }
  }, [map, styleReady, suspended, fix, following, followPaused, courseUp, heading.heading])

  /**
   * Grows the rider's marker for the road and shrinks it again for the planning screen.
   *
   * Its own effect rather than a line in the camera effect above: that one runs on every fix,
   * and setting a paint property once a second is work for nothing. This runs twice a ride.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || suspended) return
    setPositionEmphasis(instance, riding)
  }, [map, styleReady, suspended, riding])

  /**
   * Swallows the undo iOS offers when the phone is shaken.
   *
   * Shake-to-undo is a system gesture, and a bike on cobbles performs it continuously: the
   * ride reported an "Undo Typing" alert appearing every few seconds. WebKit gives a page no
   * way to decline the alert — the only lever is to have nothing undoable in the document, so
   * the riding screen now carries no text field at all (see `RideSummary.tsx`).
   *
   * This is the second half of that: if an earlier edit *is* still on WebKit's undo stack —
   * a name typed in the library, a weight typed in Setup, in this same page load — then
   * shaking would silently revert it. Refusing `historyUndo` while riding means the worst
   * outcome is an alert that does nothing, rather than an alert that quietly edits something
   * the rider cannot see.
   *
   * A rider who genuinely wants the alert gone can turn Shake to Undo off in Settings →
   * Accessibility → Touch. Nothing in a web app can do it for them.
   */
  useEffect(() => {
    if (!riding) return
    const refuse = (event: Event) => {
      const type = (event as InputEvent).inputType
      if (type === 'historyUndo' || type === 'historyRedo') event.preventDefault()
    }
    document.addEventListener('beforeinput', refuse)
    return () => document.removeEventListener('beforeinput', refuse)
  }, [riding])

  const centreOnMe = useCallback(async () => {
    if (suspended) return
    setFollowPaused(false)
    const here = await locateOnce()
    if (here && map.current) {
      map.current.easeTo({ center: [here.lon, here.lat], zoom: Math.max(map.current.getZoom(), 15) })
    }
  }, [locateOnce, map, suspended])

  /**
   * Turning the voice on has to speak *something*, immediately, from inside this tap.
   *
   * A rider who muted last session starts the next one with `voice` off, so `startRiding`
   * never primes — and iOS will not let the page speak from an effect it has not first spoken
   * from inside a gesture. Without this the button would light up and nothing would ever be
   * heard. The confirmation doubles as the unlock.
   */
  const toggleVoice = useCallback(() => {
    const next = !voice
    setVoice(next)
    if (next) announcer.say('Voice on.')
  }, [voice, announcer])

  const toggleCourseUp = useCallback(() => {
    const next = !courseUp
    setCourseUp(next)
    // Outside the updater, not inside it. StrictMode double-invokes updaters, and the second
    // `requestPermission()` rejects while the first prompt is still open — so the catch marked
    // the compass denied even when the rider allowed it.
    //
    // iOS will only hand the compass over from inside a user gesture, and this is one. Asking
    // on mount instead produces a prompt nobody expects and a rejection that cannot be retried.
    if (next && heading.permission === 'unknown') void heading.request()
  }, [courseUp, heading])

  // ── Rerouting ─────────────────────────────────────────────────────────────────────────
  /**
   * Route again from here, and keep the ride that has already happened.
   *
   * The engine is only ever asked about the road ahead. Everything behind the rider — the line
   * they rode, the start they set off from, the vias they have gone through, the distance and
   * the climbing they have banked — is kept and the new leg is joined onto it. Replacing the
   * whole route, which is what this did, made every figure on the screen change at once because
   * of a wrong turn. See `stitch.ts` and `useRoute.rerouteFrom`.
   */
  const reroute = useCallback(async () => {
    const { plan: current, fix: here, telemetry: state } = live.current
    // `rerouteProfile`, not `chosen`: following a recorded track sets `chosen` to a
    // pseudo-profile that names no `.brf`, and asking the engine for it would fail at the one
    // moment the rider needs an answer. See `useRoute.rerouteProfile`.
    const profile = current.rerouteProfile
    if (!here || !state.geometry || !profile) return
    lastRerouteAt.current = Date.now()
    setRerouting(true)
    try {
      const alongM = state.progress?.position.alongM ?? 0
      const { behind, ahead } = splitWaypoints(state.geometry, current.waypoints, alongM)
      await current.rerouteFrom({
        from: { lon: here.lon, lat: here.lat },
        behind,
        remaining: ahead,
        profileId: profile,
        // No snapped position means nothing is known about how far along the rider is, and a
        // prefix guessed at zero would claim they are still at the start. Then, and only then,
        // the old behaviour is the honest one: route from here and start the trip again.
        prefix:
          state.progress && current.route
            ? riddenPrefix(state.geometry, current.route, alongM)
            : null,
      })
    } finally {
      setRerouting(false)
    }
  }, [])

  useEffect(() => {
    if (!riding || !telemetry.offRoute || rerouting) return
    if (!rider.setup.autoReroute) return
    if (Date.now() - lastRerouteAt.current < REROUTE_COOLDOWN_MS) return
    void reroute()
  }, [riding, telemetry.offRoute, telemetry.progress, rerouting, rider.setup.autoReroute, reroute])

  /**
   * Building a place index blocks the engine Worker for a few seconds, and the next thing that
   * Worker might be asked for is the reroute that gets a lost rider home. So it stops for the
   * length of the ride. Nothing is lost by waiting: the map still draws every name it always
   * did, and the search screen is not reachable from the riding screen anyway.
   */
  useEffect(() => {
    places.hold(riding)
    return () => places.hold(false)
  }, [riding])

  const startRiding = useCallback(async () => {
    if (suspended) return
    setRiding(true)
    setFollowPaused(false)
    lastRerouteAt.current = 0
    // Ride can be started from inside the drawer, which covers the map it is about to lock
    // to the rider.
    closeSheet.current()
    // Both of these must happen inside the tap that started the ride. iOS will not grant the
    // compass outside a user gesture, and it will not let the page speak until it has spoken
    // once from inside one — silently, in both cases.
    if (courseUp && heading.permission === 'unknown') void heading.request()
    if (voice) announcer.prime()
    const here = await locateOnce()
    if (!map.current) return
    map.current.easeTo({
      center: here ? [here.lon, here.lat] : map.current.getCenter(),
      zoom: RIDING_ZOOM,
      duration: 900,
    })
  }, [locateOnce, map, suspended, courseUp, heading, announcer, voice])

  /**
   * The rail, in visual order top to bottom. An array rather than seven hand-written buttons so
   * the collapse animation can index off it — the travel and stagger are both functions of a
   * button's position in the stack, and hand-numbering them would rot the first time one moved.
   */
  /**
   * The rail's imperative map writers, behind the same flag as the effects.
   *
   * Unreachable today: `body:has(.picker) .ride-chrome { display: none }` takes the rail out
   * of hit-testing entirely. But that leaves a CSS rule load-bearing for who owns the map,
   * which is precisely the guarantee the `suspended` doc comment above says CSS cannot give —
   * and a comment that contradicts the code beside it is worse than no comment. One flag, one
   * rule, in both places.
   */
  const ifLive = (act: () => void) => () => {
    if (!suspended) act()
  }

  /**
   * Two buttons, and no chevron to fold them away.
   *
   * The rail was seven and a toggle, which is a control for a control. Placing and the saved
   * list moved into the plan card, where they belong to what the rider is actually doing; the
   * daylight map, the path mode and follow moved into Layers, because you set them once and
   * then never touch them again. What is left is the two things you reach for *at a junction*,
   * and two buttons need no machinery to put away.
   */
  const controls: RailControl[] = [
    {
      key: 'layers',
      icon: <LayersIcon />,
      // Names the sheet, not just its first group: Setup is behind this button too, and it is
      // the only way in once a plan is on the map.
      label: 'Map layers, daylight and setup',
      active: layersOpen,
      onClick: ifLive(() => setLayersOpen(true)),
    },
    {
      key: 'locate',
      icon: <TargetIcon />,
      label: 'Centre on my location',
      onClick: centreOnMe,
    },
  ]

  const problem = plan.error ?? mapError ?? fixError ?? workerProblem
  /** How many routes are on the map. More than one, with none chosen, is the decision state. */
  const routeCount = Object.keys(plan.routes).length

  /**
   * Frames the plan the search screen is about to commit.
   *
   * Without it the rider picks Portobello from a list and the map stays wherever it was — which
   * on a first run is the middle of whichever region opened. The route's own `fitBounds` cannot
   * do this: it only runs once there is a line, and the two most interesting moments are before
   * that (one end chosen) and instead of it (routing failed for want of road data).
   *
   * It takes coordinates rather than a slot and a point, because the search screen already knows
   * what the plan is about to be — one place, both ends, or a saved place plus the rider — and
   * three ways of saying that here would be three ways to get it wrong.
   *
   * It is deliberately **not** in the waypoint effect. A tap on the map must never move the
   * camera — that is a rider placing a pin and having the ground slide out from under the next
   * one — so this is only ever called from the search screen, which is the one place a point
   * arrives from somewhere the rider is not already looking.
   */
  const framePicked = useCallback(
    (coords: [number, number][]) => {
      const instance = map.current
      if (!instance || suspended || coords.length === 0) return
      if (coords.length === 1) {
        instance.easeTo({
          center: coords[0],
          zoom: Math.max(instance.getZoom(), 14),
          duration: 600,
        })
        return
      }
      const bounds = boundsOf(coords)
      if (bounds) {
        instance.fitBounds(bounds, {
          padding: { top: 110, bottom: sheetClearance(instance.getContainer()), left: 45, right: 45 },
          duration: 700,
        })
      }
    },
    [map, suspended],
  )

  const bar = useBottomBarHeight(riding)

  /**
   * Where the search measures its distances from.
   *
   * The rider's own fix when there is one, and the middle of the map otherwise. The map centre
   * is the better fallback than nothing: a rider who has panned to Peebles is asking about
   * Peebles, and "5.2 km" against every result is most of what makes a list of forty streets
   * usable. Read when the screen opens rather than followed, because a `move` listener that
   * re-ranks a list under a rider's thumb is worse than a figure a few seconds old.
   */
  const searchNear = useMemo(() => {
    if (fix) return { lon: fix.lon, lat: fix.lat }
    const centre = map.current?.getCenter()
    return centre ? { lon: centre.lng, lat: centre.lat } : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix, searching])

  const summary = telemetry.finished && telemetry.finishedRecord && (
    <RideSummarySheet
      summary={telemetry.finished}
      record={telemetry.finishedRecord}
      onDismiss={telemetry.dismissFinished}
    />
  )

  if (riding) {
    return (
      <div className="ride" data-riding="yes" style={bar.style}>
        <div ref={container} className="ride-map" />
        <div ref={bar.chrome} className="ride-chrome">
          <RideHud
            telemetry={telemetry}
            expanded={hudExpanded}
            onExpandedChange={setHudExpanded}
            speedMps={fix?.speed ?? null}
            fixLabel={FIX_LABEL[fixStatus](fix?.accuracy ?? null, wakeLock.supported)}
            offRouteHint={
              telemetry.progress ? `${formatAway(telemetry.progress.position.offsetM)} off` : null
            }
            onReroute={() => void reroute()}
            rerouting={rerouting || plan.routing !== null}
            onEnd={() => setRiding(false)}
            controls={
              <>
                {problem && (
                  <p className="ride-error" role="alert">
                    {problem}
                  </p>
                )}
                <div className="map-controls map-controls-riding">
                  {announcer.supported && (
                    <button
                      type="button"
                      className="icon-button"
                      data-active={voice ? 'yes' : 'no'}
                      aria-pressed={voice}
                      onClick={toggleVoice}
                      aria-label={voice ? 'Stop speaking the climbs' : 'Speak the climbs ahead'}
                    >
                      {voice ? <SpeakerIcon /> : <SpeakerOffIcon />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    data-active={courseUp ? 'yes' : 'no'}
                    aria-pressed={courseUp}
                    onClick={toggleCourseUp}
                    aria-label={
                      courseUp ? 'Keep the map north-up' : 'Turn the map to face my way'
                    }
                  >
                    <CompassIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    data-active={followPaused ? 'yes' : 'no'}
                    onClick={centreOnMe}
                    aria-label={followPaused ? 'Resume following me' : 'Recentre on me'}
                  >
                    <TargetIcon />
                  </button>
                </div>
              </>
            }
          />
        </div>
        {summary}
      </div>
    )
  }

  return (
    <div className="ride" style={bar.style}>
      <div ref={container} className="ride-map" />

      <div ref={bar.chrome} className="ride-chrome">
        {/*
          One sentence, and only when there is something to say.

          The three route figures used to live up here as a permanent rail. They are on the
          route cards now, where they are what the choice is actually made on — and a rail
          repeating them over the map was the same numbers twice, one copy of which was covering
          the road the rider was looking at.
        */}
        {/*
          The search field, and the one piece of chrome at the top of the planning screen.

          It replaces the two "tap the map" hints rather than joining them: the plan card already
          says both, and a map app that opens with an instruction where every other one opens
          with a search field reads as missing the field. The other four hints below are states
          the rider genuinely cannot see from the map — no map installed, a failed open, a run in
          progress, a choice still to make.
        */}
        <div className="rail">
          {aiming ? (
            <p className="map-aim">
              <span>Tap the map for your {aiming === 'start' ? 'start' : aiming === 'stop' ? 'stop' : 'finish'}</span>
              <button type="button" onClick={() => setAiming(null)}>
                Cancel
              </button>
            </p>
          ) : (
            <button
              type="button"
              className="map-search"
              data-planned={plan.waypoints.length > 0 ? 'yes' : 'no'}
              onClick={() => setSearching(plan.waypoints.length === 0 ? 'start' : 'finish')}
            >
              <SearchIcon />
              <span className="map-search-label">{searchLabel(plan)}</span>
              {plan.waypoints.length > 0 && (
                <span
                  className="map-search-clear"
                  role="button"
                  tabIndex={0}
                  aria-label="Clear the route"
                  onClick={(event) => {
                    // The row is a button and so is this; nesting them is invalid HTML and a
                    // target VoiceOver cannot describe, so it is a `role="button"` span and the
                    // press is stopped from reaching the field behind it.
                    event.stopPropagation()
                    plan.clear()
                    sheet.setOpen(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    event.stopPropagation()
                    plan.clear()
                    sheet.setOpen(false)
                  }}
                >
                  ×
                </span>
              )}
            </button>
          )}

          {mapStatus === 'no-basemap' ? (
            /* The one state where the routing hints below are nonsense: there is no map to
               tap. It is reachable by choice — "carry on without a region" — so it has to
               explain itself rather than looking like a failed load. */
            <p className="rail-hint panel">
              No map on this phone yet. Open Setup to download a region, or to import one.
            </p>
          ) : mapStatus === 'error' && activeBasemap === null ? (
            /* The other way to arrive with no map, and it wants different words. Nothing is
               missing from this phone, so "download a region" would be confident and wrong —
               what failed was reading what is already here, and the remedy is the collision
               this repo has already documented. The fault itself is in the alert below.
               Narrowed to "and no archive is mounted", because `refresh` also reports `error`
               for a failed import while a perfectly good map is on screen. */
            <p className="rail-hint panel">
              free-wheel could not open your map. If it is open in another tab, close that tab
              and reload.
            </p>
          ) : plan.routing !== null ? (
            <p className="rail-hint panel">Working out your routes…</p>
          ) : routeCount > 1 && plan.chosen === null ? (
            <p className="rail-hint panel">Tap a line, or a card, to choose it.</p>
          ) : null}
        </div>

        {problem && (
          <p className="ride-error" role="alert">
            {problem}
          </p>
        )}

        {/* Two buttons, bottom right, above the plan card. No collapse: there is nothing
            left worth putting away, and the chevron that used to do it was the eighth control
            on a rail of seven. */}
        <div className="map-controls">
          {controls.map((control) => (
            <button
              key={control.key}
              type="button"
              className="icon-button"
              data-active={control.active ? 'yes' : 'no'}
              aria-pressed={control.pressed}
              aria-label={control.label}
              onClick={control.onClick}
            >
              {control.icon}
            </button>
          ))}
        </div>

        <RouteSheet
          plan={plan}
          sheet={sheet}
          onStart={() => void startRiding()}
          onOpenSaved={() => setSavedOpen(true)}
          onOpenSetup={onOpenSetup}
          onSaved={() => setLibrarySaves((n) => n + 1)}
        />
      </div>

      <LayersSheet
        open={layersOpen}
        onOpenChange={setLayersOpen}
        onOpenSetup={onOpenSetup}
        theme={theme}
        onTheme={(next) => {
          if (!suspended) setTheme(next)
        }}
        pathMode={pathMode}
        onPathMode={setPathMode}
        follow={follow}
        onFollow={setFollow}
      />

      {/* Above the ride screen rather than instead of it: unmounting the map would drop its
          OPFS handles and its tile cache, and loading a route from here puts one straight back
          onto that map. */}
      {savedOpen && (
        <SavedScreen
          onClose={() => setSavedOpen(false)}
          reloadKey={librarySaves}
          onLoad={(entry) => {
            if (plan.loadSaved(entry)) {
              sheet.setView('detail')
              setSavedOpen(false)
            }
          }}
          onLoadTrack={(entry) => {
            if (plan.loadTrack(entry)) {
              sheet.setView('detail')
              setSavedOpen(false)
            }
          }}
        />
      )}
      {/* Above the ride screen rather than instead of it, for the reason every other overlay
          here is: unmounting the map would drop its OPFS handles and its whole tile cache, and
          picking a destination puts a pin straight back on that map. */}
      {searching && (
        <SearchScreen
          plan={plan}
          slot={searching}
          near={searchNear}
          onClose={() => setSearching(null)}
          onPicked={framePicked}
          onChooseOnMap={(slot) => {
            setSearching(null)
            setAiming(slot)
          }}
          onLocate={locateOnce}
          onOpenMaps={() => {
            setSearching(null)
            onOpenSetup('maps')
          }}
        />
      )}
      {summary}
    </div>
  )
}

/**
 * How much of the bottom of the map the sheet is about to cover.
 *
 * A second point completes the plan, which opens the sheet onto the route cards — so framing
 * the two ends against the *whole* viewport puts both of them behind it. Measured: the pins
 * landed at y 342 and 392 on an 844-high screen whose sheet starts at 345.
 *
 * `--sheet-open` is the open layer's own measured height, published by `useSheetDrag` for the
 * `calc()`s that draw the sheet. Reading it here is a small coupling and the honest one: it is
 * the number, and the alternative is a constant that is wrong for every state of the card. It
 * is clamped so a tall sheet cannot leave `fitBounds` with no room to fit anything into, and it
 * falls back to the closed card's clearance if the layer has not been measured yet.
 */
function sheetClearance(container: HTMLElement): number {
  const layer = container.ownerDocument.querySelector('.sheet-layer')
  const measured = layer
    ? Number.parseFloat(getComputedStyle(layer).getPropertyValue('--sheet-open'))
    : NaN
  if (!Number.isFinite(measured) || measured <= 0) return 190
  return Math.min(measured + 16, Math.max(190, container.clientHeight - 260))
}

/**
 * What the field at the top of the map says.
 *
 * Three states, and only the first is an invitation. Once there is a plan the field is
 * *describing* it — which is also what makes the × beside it read as clearing that plan rather
 * than clearing a search box.
 */
function searchLabel(plan: { waypoints: { label?: string; lat: number; lon: number }[] }): string {
  const named = (point: { label?: string; lat: number; lon: number }) =>
    point.label ?? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`
  if (plan.waypoints.length === 0) return 'Search a place or address'
  if (plan.waypoints.length === 1) return `From ${named(plan.waypoints[0])} — where to?`
  return `${named(plan.waypoints[0])} → ${named(plan.waypoints[plan.waypoints.length - 1])}`
}

/**
 * How tall the bar along the foot of the screen is, published to CSS as `--bar-height`.
 *
 * It exists for one thing: the OSM attribution. That is a licence requirement rather than
 * decoration, so it has to be visible — and the only corner nothing else claims is the bottom
 * left, where the bar now reaches. A constant offset cannot work, because there is no constant
 * to pick: the plan card is an invitation, a pair of coordinates or a route with a Start
 * button, the riding bar is one line or two, and each is a different height. So it is measured,
 * for the same reason the HUD's is.
 *
 * Whichever bar is on screen carries `data-bottom-bar`; the query re-runs when the screen
 * changes, and a `ResizeObserver` covers the card changing its mind in place.
 */
function useBottomBarHeight(riding: boolean) {
  const chrome = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = chrome.current?.querySelector('[data-bottom-bar]')
    if (!element) return
    const measure = () => setHeight(element.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [riding])

  // Left unset until it is known, so the stylesheet's own fallback is what applies rather than
  // a zero that would drop the credit under the bar for a frame.
  const style = (height === null ? undefined : { '--bar-height': `${height}px` }) as
    | React.CSSProperties
    | undefined

  return { chrome, style }
}

/**
 * The one-line status under the HUD, by fix state.
 *
 * A function per state rather than a ternary chain because two of them need the accuracy and
 * one needs to append the wake-lock caveat — and because "no location permission" is the only
 * one the rider can act on, so it must not be buried in a conditional expression.
 */
const FIX_LABEL: Record<string, (accuracy: number | null, wakeLock: boolean) => string> = {
  idle: () => 'Not tracking',
  locating: () => 'Getting a fix…',
  tracking: (accuracy, wakeLock) =>
    `±${Math.round(accuracy ?? 0)} m${wakeLock ? '' : ' · add to Home Screen to keep the screen on'}`,
  denied: () => 'No location permission',
  unavailable: () => 'No geolocation here',
  error: () => 'No fix',
}

/* Inline SVG rather than sprite lookups: a missing sprite entry would be one more thing that
   can fail silently offline. */






/**
 * A compass needle, for course-up.
 *
 * Not the navigation arrow, which is already the follow button: "go to me" and "turn the map
 * to face my way" are different requests and two identical triangles would make them look like
 * the same one.
 */
function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5 13 13l-4.5 2.5L11 11z" />
    </svg>
  )
}

/**
 * A speaker with two arcs. The arcs are what make it read as *sound* rather than as a
 * megaphone or a bookmark at 24px; the muted variant drops them for a cross, so the two states
 * differ by more than the presence of a small detail.
 */
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.3 6.5a8 8 0 0 1 0 11" />
    </svg>
  )
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </svg>
  )
}

/**
 * Three stacked sheets. The obvious icon for layers, and the one every map app uses — which is
 * the argument for it: this button opens the only thing on this screen a rider has met before.
 */
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 3 8l9 5 9-5-9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 1.5v3.5M12 19v3.5M22.5 12H19M5 12H1.5" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m15.8 15.8 4.2 4.2" />
    </svg>
  )
}
