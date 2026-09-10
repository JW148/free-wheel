import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Marker, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { useMapLibre } from './useMapLibre'
import { nextPathMode, type PathMode } from '../map/style'
import { useRoute } from './useRoute'
import { useGeolocation } from './useGeolocation'
import { useWakeLock } from './useWakeLock'
import { useHeading } from './useHeading'
import { useRideTelemetry } from './useRideTelemetry'
import { useAnnouncer } from './useAnnouncer'
import type { Rider } from './useRider'
import { sliceAlong, waypointsAhead } from './progress'
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
import { formatDistance, formatDuration } from './gpx'
import { formatAway } from './format'
import RouteSheet from './RouteSheet'
import RideHud from './RideHud'
import RideSummarySheet from './RideSummary'
import { useRouteSheet } from './useRouteSheet'

/** How close the map sits to the rider once a ride starts. Street-level, not overview. */
const RIDING_ZOOM = 16.5

const CONTROLS_KEY = 'free-wheel.controls.v1'
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
  rider,
  onOpenSetup,
}: {
  container: React.RefObject<HTMLDivElement | null>
  basemap: ReturnType<typeof useMapLibre>
  rider: Rider
  onOpenSetup: () => void
}) {
  const { map, error: mapError, styleReady, workerProblem, theme, setTheme, pathMode, setPathMode } =
    basemap
  const plan = useRoute()
  const sheet = useRouteSheet(plan)
  const [riding, setRiding] = useState(false)
  /**
   * Whether a tap on the map drops a waypoint.
   *
   * Switched off when a ride starts, and toggleable by hand the rest of the time: once a
   * route is planned the map becomes something you read and pan, and a stray tap silently
   * adding a seventh waypoint is worse than an extra button.
   */
  const [placing, setPlacing] = useState(true)
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
   * Whether the control rail is expanded. Remembered, like the theme and the path mode: a
   * rider who put the buttons away wants them away next time too, and the chevron that
   * brings them back never leaves the screen.
   */
  const [controlsOpen, setControlsOpen] = useState(() => {
    try {
      return localStorage.getItem(CONTROLS_KEY) !== 'closed'
    } catch {
      return true
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
      localStorage.setItem(CONTROLS_KEY, controlsOpen ? 'open' : 'closed')
      localStorage.setItem(COURSE_UP_KEY, courseUp ? 'on' : 'off')
      localStorage.setItem(VOICE_KEY, voice ? 'on' : 'off')
      localStorage.setItem(HUD_KEY, hudExpanded ? 'full' : 'mini')
    } catch {
      /* Private mode. The rail just opens expanded next launch. */
    }
  }, [controlsOpen, courseUp, voice, hudExpanded])

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
  const editable = placing && !riding
  const canPlace = useRef(editable)
  canPlace.current = editable
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
    if (!instance || !styleReady) return
    const onClick = (e: MapMouseEvent) => {
      const action = mapTapAction({
        profileUnderTap: canChoose.current ? routeAt(instance, e.point) : null,
        choosing: canChoose.current,
        clearableChoice: clearable.current,
        placing: canPlace.current,
      })
      if (action.do === 'choose') chooseRoute.current(action.profile)
      else if (action.do === 'clear') clearChoice.current()
      else if (action.do === 'place') addWaypoint.current(e.lngLat.lng, e.lngLat.lat)
    }
    instance.on('click', onClick)
    return () => {
      instance.off('click', onClick)
    }
  }, [map, styleReady])

  // ── Panning pauses following ──────────────────────────────────────────────────────────
  // Only a *user* drag: `originalEvent` is absent on the programmatic `easeTo` that follow
  // mode itself issues, and without that check following would cancel itself on the first fix.
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return
    const onDrag = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) setFollowPaused(true)
    }
    instance.on('dragstart', onDrag)
    return () => {
      instance.off('dragstart', onDrag)
    }
  }, [map, styleReady])

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

    const live = new Set(plan.waypoints.map((w) => w.id))
    for (const [id, marker] of markers.current) {
      if (!live.has(id)) {
        marker.remove()
        markers.current.delete(id)
      }
    }

    plan.waypoints.forEach((waypoint, index) => {
      const last = index === plan.waypoints.length - 1
      const label = index === 0 ? 'S' : last ? 'F' : String(index)
      const role = index === 0 ? 'start' : last ? 'finish' : 'via'

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
      element.setAttribute(
        'aria-label',
        editable ? `${role} point ${label}. Tap to remove.` : `${role} point ${label}`,
      )
    })
  }, [map, styleReady, plan.waypoints, editable])

  // ── The routes ────────────────────────────────────────────────────────────────────────
  const lastFitted = useRef<string | null>(null)
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return

    // While riding, the comparison is over: only the route being ridden is drawn, and it is
    // drawn as a lone route — neutral near-white, maximum contrast for a glance at speed. The
    // rejected routes stay in state, so ending the ride puts the comparison back.
    const chosenRoute = plan.chosen ? plan.routes[plan.chosen] : undefined
    const visible =
      riding && plan.chosen && chosenRoute ? { [plan.chosen]: chosenRoute } : plan.routes
    const ids = Object.keys(visible)
    const drawn = drawnRoutes(visible, plan.chosen)
    setRoutes(instance, drawn)

    // Fit only when the *set* of routes changes, and never while riding — the camera belongs
    // to the rider then, and being yanked out to an overview mid-junction is the opposite of
    // helpful.
    const signature = [...ids].sort().join(',') + '|' + plan.waypoints.length
    if (!riding && drawn.length > 0 && signature !== lastFitted.current) {
      lastFitted.current = signature
      const bounds = boundsOf(drawn.flatMap((r) => r.coords))
      if (bounds) {
        instance.fitBounds(bounds, { padding: { top: 110, bottom: 190, left: 45, right: 45 } })
      }
    }
    if (drawn.length === 0) lastFitted.current = null
  }, [map, styleReady, plan.routes, plan.chosen, plan.waypoints.length, riding])

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
    if (!instance || !styleReady) return
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
  }, [map, styleReady, riding, telemetry.geometry, travelledM, climbSpan])

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
    if (!instance || !styleReady) return

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
  }, [map, styleReady, fix, following, followPaused, courseUp, heading.heading])

  /**
   * Grows the rider's marker for the road and shrinks it again for the planning screen.
   *
   * Its own effect rather than a line in the camera effect above: that one runs on every fix,
   * and setting a paint property once a second is work for nothing. This runs twice a ride.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return
    setPositionEmphasis(instance, riding)
  }, [map, styleReady, riding])

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
    setFollowPaused(false)
    const here = await locateOnce()
    if (here && map.current) {
      map.current.easeTo({ center: [here.lon, here.lat], zoom: Math.max(map.current.getZoom(), 15) })
    }
  }, [locateOnce, map])

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
      const remaining = waypointsAhead(
        state.geometry,
        current.waypoints,
        state.progress?.position.alongM ?? 0,
      )
      await current.rerouteFrom({ lon: here.lon, lat: here.lat }, remaining, profile)
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

  const startRiding = useCallback(async () => {
    setRiding(true)
    setPlacing(false)
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
  }, [locateOnce, map, courseUp, heading, announcer, voice])

  /**
   * The rail, in visual order top to bottom. An array rather than seven hand-written buttons so
   * the collapse animation can index off it — the travel and stagger are both functions of a
   * button's position in the stack, and hand-numbering them would rot the first time one moved.
   */
  const controls: RailControl[] = [
    {
      key: 'place',
      icon: <PinIcon />,
      label: placing ? 'Stop adding points on tap' : 'Add points by tapping the map',
      active: placing,
      pressed: placing,
      onClick: () => setPlacing((p) => !p),
    },
    {
      key: 'library',
      icon: <BookmarkIcon />,
      label: 'Saved routes and rides',
      onClick: sheet.showLibrary,
    },
    {
      key: 'theme',
      icon: theme === 'dark' ? <SunIcon /> : <MoonIcon />,
      label: theme === 'dark' ? 'Switch to the daylight map' : 'Switch to the dark map',
      onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      key: 'paths',
      icon: <PathIcon />,
      label: PATH_MODE_LABEL[pathMode],
      active: pathMode !== 'none',
      onClick: () => setPathMode(nextPathMode(pathMode)),
    },
    { key: 'setup', icon: <SettingsIcon />, label: 'Setup', onClick: onOpenSetup },
    {
      key: 'locate',
      icon: <TargetIcon />,
      label: 'Centre on my location',
      onClick: centreOnMe,
    },
    {
      key: 'follow',
      icon: <NavigationIcon />,
      label: follow ? 'Stop following' : 'Follow my position',
      active: follow,
      pressed: follow,
      onClick: () => setFollow((f) => !f),
    },
  ]

  const problem = plan.error ?? mapError ?? fixError ?? workerProblem
  const route = plan.route
  /** How many routes are on the map. More than one, with none chosen, is the decision state. */
  const routeCount = Object.keys(plan.routes).length

  const summary = telemetry.finished && telemetry.finishedRecord && (
    <RideSummarySheet
      summary={telemetry.finished}
      record={telemetry.finishedRecord}
      onDismiss={telemetry.dismissFinished}
    />
  )

  if (riding) {
    return (
      <div className="ride" data-riding="yes">
        <div ref={container} className="ride-map" />
        <div className="ride-chrome">
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
    <div className="ride">
      <div ref={container} className="ride-map" />

      <div className="ride-chrome">
        <div className="rail">
          {route ? (
            <dl className="stats panel">
              <div>
                <dd>{formatDistance(route.distanceM)}</dd>
                <dt>distance</dt>
              </div>
              <div>
                <dd>{formatDuration(route.timeS)}</dd>
                <dt>moving</dt>
              </div>
              <div>
                <dd>{Math.round(route.ascendM)} m</dd>
                <dt>climbing</dt>
              </div>
            </dl>
          ) : routeCount > 1 ? (
            <p className="rail-hint panel">
              {routeCount} routes — tap one to choose it.
            </p>
          ) : (
            <p className="rail-hint panel">
              {plan.waypoints.length === 0
                ? placing
                  ? 'Tap the map to set your start.'
                  : 'Turn on point editing to plan a route.'
                : plan.waypoints.length === 1
                  ? 'Now tap where you are heading.'
                  : 'Ready when you are.'}
            </p>
          )}
        </div>

        {problem && (
          <p className="ride-error" role="alert">
            {problem}
          </p>
        )}

        {/* Bottom-anchored, so collapsing needs no layout change: the buttons slide down into
            the chevron and the chevron never moves. Transform and opacity only — a height or
            max-height animation on a backdrop-filtered stack judders on iOS. */}
        <div className="map-controls" data-collapsed={controlsOpen ? 'no' : 'yes'}>
          {/* `--i` counts from the bottom: a button's travel to the chevron is its distance
              from it, and the stagger runs off the same number. */}
          <div className="control-stack" style={{ '--n': controls.length } as React.CSSProperties}>
            {controls.map((control, index) => (
              <button
                key={control.key}
                type="button"
                className="icon-button"
                style={{ '--i': controls.length - index } as React.CSSProperties}
                data-active={control.active ? 'yes' : 'no'}
                aria-pressed={control.pressed}
                aria-label={control.label}
                onClick={control.onClick}
              >
                {control.icon}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-button controls-toggle"
            onClick={() => setControlsOpen((open) => !open)}
            aria-expanded={controlsOpen}
            aria-label={controlsOpen ? 'Hide map controls' : 'Show map controls'}
          >
            <ChevronIcon />
          </button>
        </div>

        <RouteSheet
          plan={plan}
          sheet={sheet}
          onStart={() => void startRiding()}
          onLoadSaved={(entry) => {
            if (plan.loadSaved(entry)) {
              sheet.setView('detail')
              sheet.setOpen(false)
            }
          }}
          onLoadTrack={(entry) => {
            if (plan.loadTrack(entry)) {
              sheet.setView('detail')
              sheet.setOpen(false)
            }
          }}
        />
      </div>
      {summary}
    </div>
  )
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
 * Sliders, not a cog. The obvious cog — a circle with eight spokes — is visually identical to
 * the sun used for the daylight toggle, and the two buttons sit near each other.
 */
function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h6M14 7h6M4 17h10M18 17h2" />
      <circle cx="12" cy="7" r="2.2" />
      <circle cx="16" cy="17" r="2.2" />
    </svg>
  )
}

/**
 * A forking dashed track. Deliberately not the pixel bike, which already means ride mode, and
 * not a footprint, which would name the state the button is *least* often in.
 */
function PathIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 22v-6a4 4 0 0 1 4-4h4a4 4 0 0 0 4-4V2" strokeDasharray="3.5 2.6" />
      <circle cx="6" cy="22" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="2" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Names the state the button is *in*, not the one it moves to — the map already shows the
 *  change, so a label describing the next tap reads as a contradiction of what you can see. */
const PATH_MODE_LABEL: Record<PathMode, string> = {
  rideable: 'Paths: cycleways, tracks and bridleways. Tap to add footpaths',
  all: 'Paths: all, including footpaths and steps. Tap to hide',
  none: 'Paths hidden. Tap to show cycleways and tracks',
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s6.5-6.1 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 14.9 12 21 12 21z" />
      <circle cx="12" cy="10.4" r="2.4" />
    </svg>
  )
}

/** A bookmark, for the saved list. Not a star, which everywhere else means "favourite". */
function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.4L5.5 21V4a1 1 0 0 1 1-1z" />
    </svg>
  )
}

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

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 1.5v3.5M12 19v3.5M22.5 12H19M5 12H1.5" />
    </svg>
  )
}

function NavigationIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 20 21l-8-4.4L4 21z" />
    </svg>
  )
}

/**
 * A single chevron, pointing the way the stack will move: down to put it away, up to bring it
 * back. Rotated by CSS so the glyph itself animates with the rail rather than swapping.
 */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 1.8v2.6M12 19.6v2.6M22.2 12h-2.6M4.4 12H1.8M19.2 4.8l-1.9 1.9M6.7 17.3l-1.9 1.9M19.2 19.2l-1.9-1.9M6.7 6.7 4.8 4.8" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
    </svg>
  )
}
