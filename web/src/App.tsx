import { useCallback, useEffect, useRef, useState } from 'react'
import RideView from './ride/RideView'
import SetupView from './setup/SetupView'
import { useMapLibre } from './ride/useMapLibre'
import { useRider } from './ride/useRider'
import { sharedEngine } from './engine/engineClient'
import { downloads } from './setup/downloadStore'
import { readyToRide } from './setup/pickerModel'
import './ride/ride.css'
import './App.css'

/**
 * Two screens: the ride, and everything that supports it.
 *
 * The map controller is owned here rather than inside `RideView` because Setup needs it too —
 * a downloaded or imported archive should appear on the map, and that cannot work if the map
 * only exists inside the screen Setup is covering. Setup is an overlay, not a replacement, for
 * the same reason: tearing the map down to show an import button would drop its OPFS handles
 * and its tile cache, and rebuilding both is neither fast nor free.
 *
 * ## The first run is Setup, not a screen of its own
 *
 * A phone with nothing on it opens Setup with `gate` set, which puts it on Maps with a line of
 * welcome copy and an exit worded for someone who has downloaded nothing yet. There is no
 * separate picker component, and that is the point: the old one existed only until the first
 * download succeeded and then became unreachable for the life of the install, which is how a
 * rider ended up with exactly one region and no way to ask for another.
 */
export default function App() {
  const container = useRef<HTMLDivElement | null>(null)
  const basemap = useMapLibre(container)
  // Owned here rather than in either screen: the ride screen reads it to estimate power and
  // Setup edits it, and Setup is an overlay *over* the ride screen rather than a replacement,
  // so two copies would drift.
  const rider = useRider()
  const [setupOpen, setSetupOpen] = useState(false)
  /**
   * `null` until we know whether there is anything installed, so the first-run screen does not
   * flash up for a moment on every launch before OPFS reports what is already there.
   */
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  /**
   * Whether this phone has enough to ride on. The rule itself is `readyToRide`, which is pure
   * and tested; this is the part that has to touch storage.
   */
  const askStorage = useCallback(async () => {
    const [regions, basemaps, roadData] = await Promise.all([
      sharedEngine().installedRegions(),
      sharedEngine().installedBasemaps(),
      sharedEngine().installedTiles(),
    ])
    return readyToRide({
      regions: regions.length,
      basemaps: basemaps.length,
      roadData: roadData.length,
    })
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        setNeedsSetup(!(await askStorage()))
      } catch {
        // If the engine cannot even be asked, Setup is the more useful screen — it is the one
        // that explains what the app needs and offers the manual way in.
        setNeedsSetup(true)
      }
    })()
  }, [askStorage])

  /**
   * New territory joining the map, from wherever the download was started.
   *
   * Subscribed here rather than inside the Maps screen because the Maps screen is very often
   * not mounted when this fires — queueing four regions and going away is the whole point of
   * the queue outliving the screen. `sync` splices the new archive in beside what is already
   * drawn, so this is safe mid-ride: the route line, the position dot and the waypoints all
   * stay exactly where they are.
   */
  useEffect(() => downloads.onInstalled(() => void basemap.sync()), [basemap.sync])

  /**
   * Leaving Setup.
   *
   * It only ever stands the first-run screen *down*, never back up. Deleting every region in
   * Setup is a deliberate act with its own confirmation and its own feedback; throwing the
   * rider into a full-screen welcome as they press Done would be answering a housekeeping task
   * with a takeover. It gets its turn on the next launch, where it belongs.
   */
  const closeSetup = useCallback(() => {
    setSetupOpen(false)
    setNeedsSetup(false)
  }, [])

  const openSetup = useCallback(() => setSetupOpen(true), [])
  const showSetup = setupOpen || needsSetup === true

  return (
    <>
      <RideView
        container={container}
        basemap={basemap}
        suspended={needsSetup === true}
        rider={rider}
        onOpenSetup={openSetup}
      />
      {showSetup && (
        <SetupView
          basemap={basemap}
          rider={rider}
          gate={needsSetup === true}
          onClose={closeSetup}
        />
      )}
    </>
  )
}
