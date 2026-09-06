import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Holds a screen wake lock while following a route.
 *
 * A phone on a handlebar mount that blanks every 30 seconds is useless, and iOS only
 * honours `navigator.wakeLock` in a home-screen PWA from 18.4 onward — in Safari proper it
 * may be absent entirely. So this reports its own availability rather than assuming it, and
 * the UI says plainly when the screen will sleep.
 *
 * **The lock is dropped by the system, not just by us.** Backgrounding the app, or the
 * screen locking, releases it silently; it is not reacquired on return. Hence the
 * `visibilitychange` listener — without it, following survives exactly one trip to the home
 * screen and then quietly stops working.
 */
export function useWakeLock(wanted: boolean) {
  const sentinel = useRef<WakeLockSentinel | null>(null)
  const [held, setHeld] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator

  const release = useCallback(async () => {
    try {
      await sentinel.current?.release()
    } catch {
      // Releasing an already-released lock throws; there is nothing to do about it and
      // nothing the rider needs to know.
    }
    sentinel.current = null
    setHeld(false)
  }, [])

  const acquire = useCallback(async () => {
    if (!supported || sentinel.current) return
    try {
      const lock = await navigator.wakeLock.request('screen')
      sentinel.current = lock
      setHeld(true)
      setError(null)
      // Fires when the system takes it away, which is the common case rather than the
      // exceptional one.
      lock.addEventListener('release', () => {
        sentinel.current = null
        setHeld(false)
      })
    } catch (e) {
      // A rejected request is not fatal — it means the screen will dim. Say so.
      setError(e instanceof Error ? e.message : String(e))
      setHeld(false)
    }
  }, [supported])

  useEffect(() => {
    if (wanted) void acquire()
    else void release()
  }, [wanted, acquire, release])

  useEffect(() => {
    if (!wanted) return
    const reacquire = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', reacquire)
    return () => document.removeEventListener('visibilitychange', reacquire)
  }, [wanted, acquire])

  useEffect(() => () => void release(), [release])

  return { held, supported, error }
}
