import { useCallback, useEffect, useRef, useState } from 'react'
import { Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { useMapLibre } from './useMapLibre'
import { useRoute } from './useRoute'
import { useGeolocation } from './useGeolocation'
import { useWakeLock } from './useWakeLock'
import { boundsOf, setPosition, setRouteLine } from './routeLayers'
import { formatDistance, formatDuration } from './gpx'
import RouteSheet from './RouteSheet'

/**
 * The ride screen: a full-bleed map with a stats rail above it and an action bar below.
 *
 * Everything here is sized for the actual use — a phone clamped to a handlebar, read in a
 * glance, operated with one gloved thumb. That is why the chrome is dark against the light
 * basemap, why the figures are large and tabular, and why there is exactly one primary
 * action visible at a time.
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
  const { map, status, error: mapError, styleReady, workerProblem } = basemap
  const plan = useRoute()
  const [following, setFollowing] = useState(false)
  const { fix, status: fixStatus, error: fixError, locateOnce } = useGeolocation(following)
  const wakeLock = useWakeLock(following)

  const markers = useRef(new Map<string, Marker>())
  // The click handler is registered once but needs the latest `addWaypoint`; a ref avoids
  // tearing down and rebinding the listener on every render.
  const addWaypoint = useRef(plan.addWaypoint)
  addWaypoint.current = plan.addWaypoint
  const moveWaypoint = useRef(plan.moveWaypoint)
  moveWaypoint.current = plan.moveWaypoint

  // ── Tap to place a waypoint ────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return
    const onClick = (e: { lngLat: { lng: number; lat: number } }) =>
      addWaypoint.current(e.lngLat.lng, e.lngLat.lat)
    instance.on('click', onClick)
    return () => {
      instance.off('click', onClick)
    }
  }, [map, styleReady])

  // ── Waypoint pins ─────────────────────────────────────────────────────────────────────
  // DOM markers rather than a symbol layer: they need to be individually draggable and
  // tappable, which is fiddly with a layer and free with a Marker.
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
        // Tapping a pin removes it — the fastest way to fix a misplaced tap, which is the
        // most common thing that goes wrong when placing points on a moving bus.
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          plan.removeWaypoint(waypoint.id)
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

      const element = marker.getElement()
      element.dataset.role = role
      element.textContent = label
      element.setAttribute('aria-label', `${role} point ${label}. Tap to remove.`)
    })
  }, [map, styleReady, plan.waypoints, plan.removeWaypoint])

  // ── The route line ────────────────────────────────────────────────────────────────────
  const lastDrawn = useRef<string | null>(null)
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return
    setRouteLine(instance, plan.route?.coords ?? null)

    // Fit only when the route actually changes, not on every render — otherwise panning
    // away from a route snaps you back, which is maddening.
    if (plan.route && plan.gpx !== lastDrawn.current) {
      lastDrawn.current = plan.gpx
      const bounds = boundsOf(plan.route.coords)
      if (bounds) {
        instance.fitBounds(bounds, { padding: { top: 90, bottom: 220, left: 40, right: 40 } })
      }
    }
    if (!plan.route) lastDrawn.current = null
  }, [map, styleReady, plan.route, plan.gpx])

  // ── The rider ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || !fix) return
    setPosition(instance, fix.lon, fix.lat)
    if (following) {
      instance.easeTo({ center: [fix.lon, fix.lat], duration: 700 })
    }
  }, [map, styleReady, fix, following])

  const centreOnMe = useCallback(async () => {
    const here = await locateOnce()
    if (here && map.current) {
      map.current.easeTo({ center: [here.lon, here.lat], zoom: Math.max(map.current.getZoom(), 15) })
    }
  }, [locateOnce, map])

  const problem = plan.error ?? mapError ?? fixError ?? workerProblem

  return (
    <div className="ride">
      <div ref={container} className="ride-map" />

      <div className="rail" data-routed={plan.route ? 'yes' : 'no'}>
        {plan.route ? (
          <dl className="stats">
            <div>
              <dd>{formatDistance(plan.route.distanceM)}</dd>
              <dt>distance</dt>
            </div>
            <div>
              <dd>{formatDuration(plan.route.timeS)}</dd>
              <dt>moving</dt>
            </div>
            <div>
              <dd>{Math.round(plan.route.ascendM)} m</dd>
              <dt>climbing</dt>
            </div>
          </dl>
        ) : (
          <p className="rail-hint">
            {status === 'no-basemap'
              ? 'No map imported yet.'
              : plan.waypoints.length === 0
                ? 'Tap the map to set your start.'
                : plan.waypoints.length === 1
                  ? 'Now tap where you are heading.'
                  : 'Ready when you are.'}
          </p>
        )}
        <button type="button" className="icon-button" onClick={onOpenSetup} aria-label="Setup">
          <GearIcon />
        </button>
      </div>

      {status === 'no-basemap' && (
        <div className="curtain">
          <h2>Import a map to begin</h2>
          <p>
            free-wheel works entirely offline, so it needs the map and the routing data on the
            phone before you ride. Both are files you import once.
          </p>
          <button type="button" className="primary" onClick={onOpenSetup}>
            Open setup
          </button>
        </div>
      )}

      <div className="map-controls">
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
          data-active={following ? 'yes' : 'no'}
          onClick={() => setFollowing((f) => !f)}
          aria-pressed={following}
          aria-label={following ? 'Stop following' : 'Follow my position'}
        >
          <NavigationIcon />
        </button>
      </div>

      {following && (
        <p className="following-note">
          {fixStatus === 'locating' && 'Getting a fix…'}
          {fixStatus === 'tracking' &&
            fix &&
            `Following · ±${Math.round(fix.accuracy)} m${
              fix.speed !== null ? ` · ${(fix.speed * 3.6).toFixed(1)} km/h` : ''
            }`}
          {/* Say it plainly rather than letting the screen blank mid-descent unexplained. */}
          {!wakeLock.held && wakeLock.supported && fixStatus === 'tracking' && ' · screen may sleep'}
          {!wakeLock.supported && ' · screen will sleep — this needs the home-screen app'}
        </p>
      )}

      {problem && (
        <p className="ride-error" role="alert">
          {problem}
        </p>
      )}

      <RouteSheet plan={plan} />
    </div>
  )
}

/* Icons are inline SVG rather than sprite lookups: there are three of them, and a missing
   sprite entry would be one more thing that can silently fail offline. */

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v3M12 18.4v3M21.4 12h-3M5.6 12h-3M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1M18.6 18.6l-2.1-2.1M7.5 7.5 5.4 5.4" />
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
      <path d="M12 2.5 20 21l-8-4.4L4 21z" strokeLinejoin="round" />
    </svg>
  )
}
