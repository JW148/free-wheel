import { useCallback, useEffect, useRef, useState } from 'react'
import RideView from './ride/RideView'
import SetupView from './setup/SetupView'
import RegionPicker from './setup/RegionPicker'
import { useMapLibre } from './ride/useMapLibre'
import { sharedEngine } from './engine/engineClient'
import { readyToRide } from './setup/pickerModel'
import './ride/ride.css'
import './App.css'

/**
 * Two screens: the ride, and everything that supports it.
 *
 * The map controller is owned here rather than inside `RideView` because Setup needs it too
 * — importing a basemap should switch the map to it, and that cannot work if the map only
 * exists inside the screen Setup is covering. Setup is an overlay, not a replacement, for
 * the same reason: tearing the map down to show an import button would drop its OPFS
 * handles and its tile cache, and rebuilding both is neither fast nor free.
 */
export default function App() {
  const container = useRef<HTMLDivElement | null>(null)
  const basemap = useMapLibre(container)
  // Stable, so `closeSetup` below is not rebuilt on every render.
  const { endRemote } = basemap
  const [setupOpen, setSetupOpen] = useState(false)
  /**
   * `null` until we know whether there is anything installed, so the guided flow does not
   * flash up for a moment on every launch before OPFS reports what is already there.
   */
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  /**
   * Whether this phone has enough to ride on. The rule itself is `readyToRide`, which is
   * pure and tested; this is the part that has to touch storage.
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
        // If the engine cannot even be asked, the picker is the more useful screen — it is
        // the one that explains what the app needs.
        setNeedsSetup(true)
      }
    })()
  }, [askStorage])

  /**
   * Ask again when Setup closes, because Setup is how a rider gets data onto a phone the
   * picker could not help — and without this, importing both files by hand and pressing Done
   * lands them straight back on a screen still insisting there is nothing to choose from. A
   * home-screen app has no address bar, so that was a dead end you could only leave by
   * force-quitting.
   *
   * It only ever stands the picker *down*, never back up. Deleting data in Setup is a
   * deliberate act with its own screen and its own feedback; throwing the rider into a
   * full-screen picker as they press Done would be answering a housekeeping task with a
   * takeover. The picker gets its turn on the next launch, where it belongs.
   */
  const closeSetup = useCallback(() => {
    setSetupOpen(false)
    void (async () => {
      try {
        if (!(await askStorage())) return
        // Awaited before the gate opens, never after. The picker borrowed the map, and the
        // ride screen's effects wake up the instant `needsSetup` clears — so the map has to
        // be back and `styleReady` back down first, or they run against a streamed archive
        // that is about to be torn out from under them. See `RegionPicker`'s `leave`.
        await endRemote()
        setNeedsSetup(false)
      } catch {
        // Leave the gate where it is: a storage failure says nothing new about what is
        // installed, and the picker's own screen reports it better than this can.
      }
    })()
  }, [askStorage, endRemote])

  return (
    <>
      {/* One map, two screens. While the picker is up it owns the map, and the ride screen
          must not listen to it or draw on it — see `RideView`'s `suspended` prop. */}
      <RideView
        container={container}
        basemap={basemap}
        suspended={needsSetup === true}
        onOpenSetup={() => setSetupOpen(true)}
      />
      {needsSetup === true && (
        <RegionPicker
          basemap={basemap}
          onDone={() => setNeedsSetup(false)}
          onOpenSetup={() => setSetupOpen(true)}
        />
      )}
      {setupOpen && <SetupView basemap={basemap} onClose={closeSetup} />}
    </>
  )
}
