import { useCallback, useEffect, useRef, useState } from 'react'
import { angleGap } from './geo'

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
 * The compass wins when it is available, because the case it covers is the case that matters.
 * The course is the fallback, and the fallback is good enough on its own: a moving map that
 * only orients while moving is still much better than one that never does.
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

export type HeadingSource = 'compass' | 'course'
export type CompassPermission = 'unsupported' | 'unknown' | 'granted' | 'denied'

/** Smoothing time constant. Long enough to kill compass jitter, short enough to feel live. */
const TAU_S = 0.6

/** Below this the map does not move. A map creeping by half a degree reads as broken. */
const DEADBAND_DEG = 2

interface WebkitDeviceOrientationEvent extends DeviceOrientationEvent {
  /** iOS only: degrees clockwise from true north. Absent everywhere else. */
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

type PermissionRequester = { requestPermission?: () => Promise<PermissionState | string> }

export function useHeading(active: boolean, courseDeg: number | null) {
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
  // carries the rounded, dead-banded value, which changes far less often.
  const vector = useRef<{ x: number; y: number } | null>(null)
  const lastAt = useRef<number | null>(null)

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
      return
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
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
      setCompass((current) =>
        current === null || angleGap(current, smoothed) >= DEADBAND_DEG ? smoothed : current,
      )
    }

    window.addEventListener('deviceorientation', onOrientation)
    return () => window.removeEventListener('deviceorientation', onOrientation)
  }, [active, permission])

  const source: HeadingSource | null =
    compass !== null ? 'compass' : courseDeg !== null ? 'course' : null

  return {
    /** Degrees clockwise from true north, or null when neither source can say. */
    heading: compass ?? courseDeg,
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
