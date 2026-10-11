import { useCallback, useEffect, useRef, useState } from 'react'
import { chooseHeading, shouldPublishCompass, type HeadingSource } from './camera'
import { workload } from './workload'

export type { HeadingSource }

/**
 * Which way the rider is pointing, for turning the map to match.
 *
 * Two sources, and they fail in opposite ways, which is why both are here:
 *
 * - **The compass** (`deviceorientation`) works at a standstill, which is exactly when a rider
 *   is looking at the screen trying to work out which way to set off. It is also noisy, drifts
 *   near anything ferrous, and on iOS needs an explicit permission granted from a tap.
 * - **The GPS course** (`coords.heading`) is clean and needs no permission, but iOS reports it
 *   as `null` below a few km/h — so it is `null` at every junction and every set of lights.
 *
 * **The course wins while moving, and the compass covers the rest.** It used to be the other
 * way round, and on a bike that was wrong twice over: a phone on a handlebar mount reads the
 * bars rather than the bike, and its reading moves several times a second off the road surface
 * — each movement a re-render of the riding screen and, before `camera.ts`, a restarted camera
 * animation. So above `MOVING_MPS` the course is used, and the compass is for the standstill
 * cases the course cannot cover. `chooseHeading` is that rule, and it is tested.
 *
 * ## The two traps
 *
 * **Permission needs a gesture.** `DeviceOrientationEvent.requestPermission()` on iOS must be
 * called from a user activation, so it cannot be requested on mount — hence `request()`, which
 * the course-up button calls.
 *
 * **Angles do not average.** The mean of 350° and 10° is 180°, which points the map backwards
 * once per revolution. Everything here averages the unit vector instead.
 */

export type CompassPermission = 'unsupported' | 'unknown' | 'granted' | 'denied'

/** Smoothing time constant. Long enough to kill compass jitter, short enough to feel live. */
const TAU_S = 0.6

interface WebkitDeviceOrientationEvent extends DeviceOrientationEvent {
  /** iOS only: degrees clockwise from true north. Absent everywhere else. */
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

type PermissionRequester = { requestPermission?: () => Promise<PermissionState | string> }

export function useHeading(active: boolean, courseDeg: number | null, speedMps: number | null) {
  const [compass, setCompass] = useState<number | null>(null)
  const [permission, setPermission] = useState<CompassPermission>(() =>
    typeof window === 'undefined' || !('DeviceOrientationEvent' in window)
      ? 'unsupported'
      : typeof (DeviceOrientationEvent as unknown as PermissionRequester).requestPermission ===
          'function'
        ? 'unknown'
        : 'granted',
  )

  // The smoothed heading is kept as a vector, and in a ref rather than state: it updates at
  // 60 Hz on iOS and re-rendering the whole ride screen that often would be absurd. State
  // carries the dead-banded, rate-limited value — see `shouldPublishCompass` — which changes a
  // couple of times a second at most, and only when the rider has actually turned.
  const vector = useRef<{ x: number; y: number } | null>(null)
  const lastAt = useRef<number | null>(null)
  const shown = useRef<{ heading: number; atMs: number } | null>(null)

  const request = useCallback(async () => {
    const constructor = DeviceOrientationEvent as unknown as PermissionRequester
    if (typeof constructor.requestPermission !== 'function') return
    try {
      const outcome = await constructor.requestPermission()
      setPermission(outcome === 'granted' ? 'granted' : 'denied')
    } catch {
      // iOS rejects when called outside a user gesture. Nothing to report — the button is
      // still there to tap again.
      setPermission('denied')
    }
  }, [])

  useEffect(() => {
    if (!active || permission !== 'granted') {
      vector.current = null
      lastAt.current = null
      shown.current = null
      // And the reading itself, not just the accumulator. A value left behind here is a stale
      // bearing on the next Follow, and below walking pace it would still beat the GPS course
      // in `chooseHeading` — so a stopped rider would face wherever they faced last time.
      setCompass(null)
      return
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
      workload.count('orientation')
      const raw = readHeading(event as WebkitDeviceOrientationEvent)
      if (raw === null) return

      const now = performance.now()
      const dtS = lastAt.current === null ? Infinity : (now - lastAt.current) / 1000
      lastAt.current = now

      const radians = (raw * Math.PI) / 180
      const sample = { x: Math.sin(radians), y: Math.cos(radians) }
      const weight = Number.isFinite(dtS) ? 1 - Math.exp(-dtS / TAU_S) : 1
      const previous = vector.current
      vector.current = previous
        ? {
            x: previous.x + weight * (sample.x - previous.x),
            y: previous.y + weight * (sample.y - previous.y),
          }
        : sample

      const smoothed =
        ((Math.atan2(vector.current.x, vector.current.y) * 180) / Math.PI + 360) % 360
      // Decided here, against a ref, rather than inside a state updater: an updater that
      // returns its input still costs a render scheduled and bailed out of, sixty times a
      // second, and this is the hottest path in the app.
      const publish = shouldPublishCompass({
        shown: shown.current?.heading ?? null,
        shownAtMs: shown.current?.atMs ?? null,
        next: smoothed,
        nowMs: now,
      })
      if (!publish) return
      shown.current = { heading: smoothed, atMs: now }
      workload.count('heading')
      setCompass(smoothed)
    }

    window.addEventListener('deviceorientation', onOrientation)
    return () => window.removeEventListener('deviceorientation', onOrientation)
  }, [active, permission])

  const { heading, source } = chooseHeading({ compass, course: courseDeg, speedMps })

  return {
    /** Degrees clockwise from true north, or null when neither source can say. */
    heading,
    source,
    permission,
    /** Asks iOS for the compass. Must be called from a tap. */
    request,
  }
}

/**
 * The event's heading, in the frame the *rider* is in rather than the device.
 *
 * `webkitCompassHeading` is measured against the top of the device, so a rotated screen
 * reports a heading rotated with it. The app is portrait-locked in the manifest, which makes
 * this dead code on the target device — but a browser tab is not locked, and a map that points
 * 90° wrong in landscape is worse than one that does not turn at all.
 *
 * The `alpha` fallback is deliberately only used when `absolute` is set. A relative `alpha` is
 * measured from wherever the device happened to be when the listener attached, which is not a
 * compass reading at all; using it would point the map confidently in a random direction.
 */
function readHeading(event: WebkitDeviceOrientationEvent): number | null {
  const screenAngle = typeof screen !== 'undefined' ? (screen.orientation?.angle ?? 0) : 0

  if (typeof event.webkitCompassHeading === 'number' && Number.isFinite(event.webkitCompassHeading)) {
    return (event.webkitCompassHeading + screenAngle + 360) % 360
  }
  if (event.absolute && typeof event.alpha === 'number' && Number.isFinite(event.alpha)) {
    // `alpha` counts anticlockwise from east-ish; 360 − alpha turns it into a compass bearing.
    return (360 - event.alpha + screenAngle) % 360
  }
  return null
}
