import { useCallback, useEffect, useRef, useState } from 'react'
import RideView from './ride/RideView'
import SetupView from './setup/SetupView'
import Onboarding from './onboarding/Onboarding'
import { hasOnboarded, type BikeChoice } from './onboarding/slides'
import { useMapLibre } from './ride/useMapLibre'
import { useRider } from './ride/useRider'
import { sharedEngine } from './engine/engineClient'
import { downloads } from './setup/downloadStore'
import { readyToRide } from './setup/pickerModel'
import { places } from './search/searchStore'
import './ride/ride.css'
import './App.css'
import './screens.css'
import './onboarding/onboarding.css'
import './search/search.css'

/**
 * Two screens: the ride, and everything that supports it.
 *
 * The map controller is owned here rather than inside `RideView` because Setup needs it too —
 * a downloaded or imported archive should appear on the map, and that cannot work if the map
 * only exists inside the screen Setup is covering. Setup is an overlay, not a replacement, for
 * the same reason: tearing the map down to show an import button would drop its OPFS handles
 * and its tile cache, and rebuilding both is neither fast nor free.
 *
 * ## The launch sequence, in order
 *
 * **The walkthrough, then the maps gate, then the map.** They answer different questions and
 * are stored separately on purpose. The walkthrough explains what the app is and asks what you
 * ride; it is shown once, ever. The gate is "this phone has nothing to ride on", which is a
 * situation rather than a milestone — a rider who deletes every region to free space meets it
 * again, and would be insulted by a six-card introduction to an app they have been using for a
 * month.
 *
 * The gate itself is Setup rather than a screen of its own. There is no separate picker
 * component, and that is the point: the old one existed only until the first download
 * succeeded and then became unreachable for the life of the install, which is how a rider
 * ended up with exactly one region and no way to ask for another.
 */
export default function App() {
  const container = useRef<HTMLDivElement | null>(null)
  const basemap = useMapLibre(container)
  // Owned here rather than in either screen: the ride screen reads it to estimate power and
  // Setup edits it, and Setup is an overlay *over* the ride screen rather than a replacement,
  // so two copies would drift.
  const rider = useRider()
  /** `null` is closed; a string is open on that page, and `''` is open on the menu. */
  const [setupOpen, setSetupOpen] = useState<'maps' | 'rider' | '' | null>(null)
  /** Read once, at mount: it must not re-show because a render happened. */
  const [onboarding, setOnboarding] = useState(() => !hasOnboarded())
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
   * The place index follows the archives, from here rather than from the search screen.
   *
   * Same rule as the engine's own setup: never let it depend on a component having mounted. A
   * rider who downloads a region and then opens search should find it already searchable, and
   * one who opens search the moment the app starts should not be the reason the index gets
   * built. `basemap.archives` is what `sync` publishes, so this fires on startup, on a finished
   * download, on a hand import and on a removal — the same four moments the map itself changes.
   */
  useEffect(() => {
    void places.sync(basemap.archives)
  }, [basemap.archives])

  /**
   * Leaving Setup.
   *
   * It only ever stands the first-run screen *down*, never back up. Deleting every region in
   * Setup is a deliberate act with its own confirmation and its own feedback; throwing the
   * rider into a full-screen welcome as they press Done would be answering a housekeeping task
   * with a takeover. It gets its turn on the next launch, where it belongs.
   */
  const closeSetup = useCallback(() => {
    setSetupOpen(null)
    setNeedsSetup(false)
  }, [])

  const openSetup = useCallback((page?: 'maps' | 'rider') => setSetupOpen(page ?? ''), [])

  /**
   * Finishing the walkthrough.
   *
   * The bike answer lands in the rider's setup rather than in the plan, because it is a
   * property of the rider: which style to suggest, and the two inputs to the power model that
   * a rider would otherwise never touch. All three stay editable in *You and the bike*.
   */
  const finishOnboarding = useCallback(
    (bike: BikeChoice) => {
      rider.update({ style: bike.profile, position: bike.position, tyres: bike.tyres })
      setOnboarding(false)
    },
    [rider],
  )

  // The walkthrough covers the gate, so the gate does not also render underneath it. Both are
  // full-screen and opaque; stacking them would mean a flash of Setup on every first launch.
  const showSetup = !onboarding && (setupOpen !== null || needsSetup === true)

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
          openOn={setupOpen || undefined}
          onClose={closeSetup}
        />
      )}
      {onboarding && <Onboarding onDone={finishOnboarding} />}
    </>
  )
}
