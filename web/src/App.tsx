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
  const [setupOpen, setSetupOpen] = useState(false)
  /**
   * `null` until we know whether there is anything installed, so the guided flow does not
   * flash up for a moment on every launch before OPFS reports what is already there.
   */
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  /**
   * Whether the picker has been asked to stand down.
   *
   * A request, not the act. The picker borrowed the map and it is the one that gives it back,
   * so flipping `needsSetup` from here would open the gate onto a map still on loan — and
   * would do it from a second piece of code that has to get the same ordering right, which is
   * how the last three attempts at this went wrong. `App` asks; the picker performs the
   * handback, reports it, and calls `onDone` if it worked.
   */
  const [standDown, setStandDown] = useState(false)

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
        // Asks the picker to leave rather than dropping it. It is holding the map, the
        // handback has to finish before the ride screen's effects wake up, and it can fail —
        // all three are the picker's to deal with, and it is the screen that is on top and
        // can say so. When there is no picker this is inert, which is correct: nothing else
        // ever borrows the map.
        setStandDown(true)
      } catch {
        // The gate stays where it is. A storage fault says nothing new about what is
        // installed, and standing the picker down on an answer that never arrived could put a
        // rider on the ride screen with nothing to ride on.
        //
        // It is not, however, free of silence — and the comment here used to claim otherwise.
        // When the picker is showing its list, its own storage read having succeeded earlier,
        // Done just looks inert: nothing on screen says the check failed. Recorded as an open
        // item. The fix is to hand this fault to the picker's failure surface, which now
        // exists; adding a fifth, unexercised route into that surface in the last round is
        // the wrong trade.
      }
    })()
  }, [askStorage])

  /**
   * The picker's way out, and stable by construction.
   *
   * It is a dependency of the picker's `leave`, which now runs from an effect as well as from
   * a tap — a fresh arrow every render would make that effect re-fire on renders that mean
   * nothing.
   */
  const standDownDone = useCallback(() => {
    setStandDown(false)
    setNeedsSetup(false)
  }, [])
  const openSetup = useCallback(() => setSetupOpen(true), [])

  return (
    <>
      {/* One map, two screens. While the picker is up it owns the map, and the ride screen
          must not listen to it or draw on it — see `RideView`'s `suspended` prop. */}
      <RideView
        container={container}
        basemap={basemap}
        suspended={needsSetup === true}
        onOpenSetup={openSetup}
      />
      {needsSetup === true && (
        <RegionPicker
          basemap={basemap}
          standDown={standDown}
          onDone={standDownDone}
          onOpenSetup={openSetup}
        />
      )}
      {setupOpen && <SetupView basemap={basemap} onClose={closeSetup} />}
    </>
  )
}
