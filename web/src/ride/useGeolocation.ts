import { useCallback, useEffect, useRef, useState } from 'react'

export interface Fix {
  lon: number
  lat: number
  /** Metres. iOS reports this honestly and it is the difference between a usable fix and a guess. */
  accuracy: number
  /** Degrees from true north, or null when standing still — iOS omits it below a threshold. */
  heading: number | null
  /** Metres per second, or null. */
  speed: number | null
  at: number
}

type Status = 'idle' | 'locating' | 'tracking' | 'denied' | 'unavailable' | 'error'

/**
 * The rider's position, from `watchPosition`.
 *
 * Deliberately foreground-only. iOS suspends a backgrounded web app's timers and geolocation
 * within seconds, so a "background tracking" feature would work on the desk and fail on the
 * road — worse than not offering it. The wake lock (see `useWakeLock`) is what keeps this
 * alive while riding, by keeping the app in front.
 *
 * `enableHighAccuracy` is on: this is a map-matching use case, and the low-accuracy provider
 * on iOS can be several hundred metres out, which puts the dot on the wrong street.
 */
export function useGeolocation(active: boolean) {
  const [fix, setFix] = useState<Fix | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const watchId = useRef<number | null>(null)

  const handleError = useCallback((e: GeolocationPositionError) => {
    // PERMISSION_DENIED is the one worth distinguishing: it is the only one the rider can
    // do anything about, and the fix is in Settings rather than in the app.
    if (e.code === e.PERMISSION_DENIED) {
      setStatus('denied')
      setError('Location permission denied — allow it in Settings → Safari, or for this app.')
      return
    }
    setStatus('error')
    setError(
      e.code === e.TIMEOUT
        ? 'Timed out waiting for a GPS fix.'
        : (e.message || 'Could not get a position.'),
    )
  }, [])

  const receive = useCallback((p: GeolocationPosition) => {
    setStatus('tracking')
    setError(null)
    setFix({
      lon: p.coords.longitude,
      lat: p.coords.latitude,
      accuracy: p.coords.accuracy,
      heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null,
      speed: Number.isFinite(p.coords.speed) ? p.coords.speed : null,
      at: p.timestamp,
    })
  }, [])

  useEffect(() => {
    if (!active) {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current)
        watchId.current = null
      }
      setStatus('idle')
      return
    }

    if (!('geolocation' in navigator)) {
      setStatus('unavailable')
      setError('This browser has no geolocation. It needs a secure context (HTTPS).')
      return
    }

    setStatus('locating')
    watchId.current = navigator.geolocation.watchPosition(receive, handleError, {
      enableHighAccuracy: true,
      // Never hand back a cached fix: a stale position on a moving bike is worse than none.
      maximumAge: 0,
      timeout: 20_000,
    })

    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
  }, [active, receive, handleError])

  /** A single fix, for the "centre on me" button — no watch, no wake lock. */
  const locateOnce = useCallback(
    () =>
      new Promise<Fix | null>((resolve) => {
        if (!('geolocation' in navigator)) {
          setStatus('unavailable')
          resolve(null)
          return
        }
        setStatus('locating')
        navigator.geolocation.getCurrentPosition(
          (p) => {
            receive(p)
            resolve({
              lon: p.coords.longitude,
              lat: p.coords.latitude,
              accuracy: p.coords.accuracy,
              heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null,
              speed: Number.isFinite(p.coords.speed) ? p.coords.speed : null,
              at: p.timestamp,
            })
          },
          (e) => {
            handleError(e)
            resolve(null)
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
        )
      }),
    [receive, handleError],
  )

  return { fix, status, error, locateOnce }
}
