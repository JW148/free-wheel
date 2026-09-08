import { useCallback, useState } from 'react'
import { loadRider, saveRider, type RiderSetup } from './rider'

/**
 * The rider's setup, read once and written on every change.
 *
 * Owned by `App` rather than by either screen that uses it: the ride screen reads it to
 * estimate power, and Setup edits it, and Setup is an overlay over the ride screen rather than
 * a replacement for it. Two independent copies would mean a weight changed in Setup did not
 * reach the power estimate until a reload.
 */
export function useRider() {
  const [setup, setSetup] = useState<RiderSetup>(loadRider)

  const update = useCallback((patch: Partial<RiderSetup>) => {
    setSetup((current) => {
      const next = { ...current, ...patch }
      saveRider(next)
      return next
    })
  }, [])

  return { setup, update }
}

export type Rider = ReturnType<typeof useRider>
