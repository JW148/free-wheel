import { useCallback, useEffect, useRef, useState } from 'react'
import { Marker, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { useMapLibre } from './useMapLibre'
import { nextPathMode, type PathMode } from '../map/style'
import { useRoute } from './useRoute'
import { useGeolocation } from './useGeolocation'
import { useWakeLock } from './useWakeLock'
import { boundsOf, drawnRoutes, mapTapAction, routeAt, setPosition, setRoutes } from './routeLayers'
import { formatDistance, formatDuration } from './gpx'
import RouteSheet from './RouteSheet'
import { useRouteSheet } from './useRouteSheet'

/** How close the map sits to the rider once a ride starts. Street-level, not overview. */
const RIDING_ZOOM = 16.5

/**
 * The ride screen: a full-bleed map with controls floating over it.
 *
 * It has two modes, and they want opposite things:
 *
 * - **Planning** — tap to place points, compare styles, read an elevation profile. Chrome is
 *   welcome; you are sitting still and looking at the screen.
 * - **Riding** — one glance, at speed, one-handed. Everything not needed for the next
 *   junction gets out of the way, the camera locks to the rider, and tapping the map no
 *   longer places a waypoint — a bump in the road should not edit the route.
 */
export default function RideView({
  container,
  basemap,
  onOpenSetup,
}: {
  container: React.RefObject<HTMLDivElement | null>
  basemap: ReturnType<typeof useMapLibre>
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

  // Riding implies following, and implies not editing.
  const following = riding || follow
  const { fix, status: fixStatus, error: fixError, locateOnce } = useGeolocation(following)
  const wakeLock = useWakeLock(riding)

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

  // ── The rider ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || !fix) return
    setPosition(instance, fix.lon, fix.lat)
    if (following) instance.easeTo({ center: [fix.lon, fix.lat], duration: 700 })
  }, [map, styleReady, fix, following])

  const centreOnMe = useCallback(async () => {
    const here = await locateOnce()
    if (here && map.current) {
      map.current.easeTo({ center: [here.lon, here.lat], zoom: Math.max(map.current.getZoom(), 15) })
    }
  }, [locateOnce, map])

  const startRiding = useCallback(async () => {
    setRiding(true)
    setPlacing(false)
    // Ride can be started from inside the drawer, which covers the map it is about to lock
    // to the rider.
    closeSheet.current()
    const here = await locateOnce()
    if (!map.current) return
    map.current.easeTo({
      center: here ? [here.lon, here.lat] : map.current.getCenter(),
      zoom: RIDING_ZOOM,
      duration: 900,
    })
  }, [locateOnce, map])

  const problem = plan.error ?? mapError ?? fixError ?? workerProblem
  const route = plan.route
  /** How many routes are on the map. More than one, with none chosen, is the decision state. */
  const routeCount = Object.keys(plan.routes).length

  if (riding) {
    return (
      <div className="ride" data-riding="yes">
        <div ref={container} className="ride-map" />
        <div className="ride-chrome">
          <div className="rail">
            {route && (
              <dl className="stats panel">
                <div>
                  <dd>{formatDistance(route.distanceM)}</dd>
                  <dt>route</dt>
                </div>
                <div>
                  <dd>{fix?.speed != null ? (fix.speed * 3.6).toFixed(1) : '—'}</dd>
                  <dt>km/h</dt>
                </div>
                <div>
                  <dd>{formatDuration(route.timeS)}</dd>
                  <dt>est.</dt>
                </div>
              </dl>
            )}
          </div>

          {problem && (
            <p className="ride-error" role="alert">
              {problem}
            </p>
          )}

          <div className="map-controls">
            <button
              type="button"
              className="icon-button"
              onClick={centreOnMe}
              aria-label="Recentre on me"
            >
              <TargetIcon />
            </button>
          </div>

          <div className="ride-status panel">
            <span className="ride-status-text">
              {fixStatus === 'locating' && 'Getting a fix…'}
              {fixStatus === 'tracking' && fix && `Following · ±${Math.round(fix.accuracy)} m`}
              {fixStatus === 'denied' && 'No location permission'}
              {fixStatus === 'error' && 'No fix'}
              {!wakeLock.supported && ' · add to Home Screen to keep the screen on'}
            </span>
            <button type="button" className="ghost" onClick={() => setRiding(false)}>
              End ride
            </button>
          </div>
        </div>
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

        <div className="map-controls">
          <button
            type="button"
            className="icon-button"
            data-active={placing ? 'yes' : 'no'}
            onClick={() => setPlacing((p) => !p)}
            aria-pressed={placing}
            aria-label={placing ? 'Stop adding points on tap' : 'Add points by tapping the map'}
          >
            <PinIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to the daylight map' : 'Switch to the dark map'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            data-active={pathMode === 'none' ? 'no' : 'yes'}
            onClick={() => setPathMode(nextPathMode(pathMode))}
            aria-label={PATH_MODE_LABEL[pathMode]}
          >
            <PathIcon />
          </button>
          <button type="button" className="icon-button" onClick={onOpenSetup} aria-label="Setup">
            <SettingsIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={centreOnMe}
            aria-label="Centre on my location"
          >
            <TargetIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            data-active={follow ? 'yes' : 'no'}
            onClick={() => setFollow((f) => !f)}
            aria-pressed={follow}
            aria-label={follow ? 'Stop following' : 'Follow my position'}
          >
            <NavigationIcon />
          </button>
        </div>

        <RouteSheet plan={plan} sheet={sheet} onStart={() => void startRiding()} />
      </div>
    </div>
  )
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
