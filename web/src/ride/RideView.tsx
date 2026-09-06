import { useCallback, useEffect, useRef, useState } from 'react'
import { Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { useMapLibre } from './useMapLibre'
import { profileById, useRoute } from './useRoute'
import { useGeolocation } from './useGeolocation'
import { useWakeLock } from './useWakeLock'
import { boundsOf, setPosition, setRoutes, type DrawnRoute } from './routeLayers'
import { formatDistance, formatDuration } from './gpx'
import RouteSheet from './RouteSheet'

/**
 * The ride screen: a full-bleed map with controls floating over it.
 *
 * Everything is sized for the real use — a phone clamped to a handlebar, read at a glance,
 * operated with one gloved thumb. Hence large tabular figures, generous targets, and exactly
 * one primary action visible at a time.
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
  const { map, status, error: mapError, styleReady, workerProblem, theme, setTheme } = basemap
  const plan = useRoute()
  const [following, setFollowing] = useState(false)
  const { fix, status: fixStatus, error: fixError, locateOnce } = useGeolocation(following)
  const wakeLock = useWakeLock(following)

  const markers = useRef(new Map<string, Marker>())
  // The click handler is registered once but needs the latest callbacks; refs avoid tearing
  // down and rebinding the listener on every render.
  const addWaypoint = useRef(plan.addWaypoint)
  addWaypoint.current = plan.addWaypoint
  const moveWaypoint = useRef(plan.moveWaypoint)
  moveWaypoint.current = plan.moveWaypoint
  const removeWaypoint = useRef(plan.removeWaypoint)
  removeWaypoint.current = plan.removeWaypoint

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
        // Tapping a pin removes it — the fastest way to undo a misplaced tap, which is the
        // most common thing that goes wrong when placing points one-handed.
        // Through a ref, like the other two: this listener is attached once per marker and
        // would otherwise capture the first render's callback for the marker's whole life.
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          removeWaypoint.current(waypoint.id)
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
  }, [map, styleReady, plan.waypoints])

  // ── The routes ────────────────────────────────────────────────────────────────────────
  const lastFitted = useRef<string | null>(null)
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return

    const drawn: DrawnRoute[] = Object.entries(plan.routes).map(([id, route]) => ({
      id,
      coords: route.coords,
      colour: profileById(id).colour,
      focused: id === plan.focused,
    }))
    setRoutes(instance, drawn)

    // Fit only when the *set* of routes changes, not on every render and not when the focus
    // moves between them — otherwise panning away snaps you back, which is maddening, and
    // tapping a profile to compare would yank the map about.
    const signature = Object.keys(plan.routes).sort().join(',') + '|' + plan.waypoints.length
    if (drawn.length > 0 && signature !== lastFitted.current) {
      lastFitted.current = signature
      const bounds = boundsOf(drawn.flatMap((r) => r.coords))
      if (bounds) {
        instance.fitBounds(bounds, { padding: { top: 110, bottom: 190, left: 45, right: 45 } })
      }
    }
    if (drawn.length === 0) lastFitted.current = null
  }, [map, styleReady, plan.routes, plan.focused, plan.waypoints.length])

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

  const problem = plan.error ?? mapError ?? fixError ?? workerProblem
  const route = plan.route

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
          ) : (
            <p className="rail-hint panel">
              {status === 'no-basemap'
                ? 'No map imported yet.'
                : plan.waypoints.length === 0
                  ? 'Tap the map to set your start.'
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
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to the daylight map' : 'Switch to the dark map'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
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
            {/* Said plainly rather than letting the screen blank mid-descent unexplained. */}
            {!wakeLock.held && wakeLock.supported && fixStatus === 'tracking' && ' · screen may sleep'}
            {!wakeLock.supported && ' · screen will sleep — add to Home Screen to prevent it'}
          </p>
        )}

        <RouteSheet plan={plan} />
      </div>
    </div>
  )
}

/* Inline SVG rather than sprite lookups: there are five, and a missing sprite entry would be
   one more thing that can fail silently offline. */

/**
 * Sliders, not a cog.
 *
 * The obvious cog — a circle with eight spokes — is visually identical to the sun used for
 * the daylight toggle, and the two buttons sit one above the other. Two controls that look
 * the same and do unrelated things is worse than a slightly less conventional icon.
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
