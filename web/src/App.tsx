import { useEffect, useRef, useState } from 'react'
import RideView from './ride/RideView'
import SetupView from './setup/SetupView'
import RegionPicker from './setup/RegionPicker'
import { useMapLibre } from './ride/useMapLibre'
import { sharedEngine } from './engine/engineClient'
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

  useEffect(() => {
    void (async () => {
      try {
        const [regions, archives, tiles] = await Promise.all([
          sharedEngine().installedRegions(),
          sharedEngine().installedBasemaps(),
          sharedEngine().installedTiles(),
        ])
        // A phone that imported files by hand before regions existed is set up, and must not
        // be sent back to the picker.
        setNeedsSetup(regions.length === 0 && (archives.length === 0 || tiles.length === 0))
      } catch {
        // If the engine cannot even be asked, the picker is the more useful screen — it is
        // the one that explains what the app needs.
        setNeedsSetup(true)
      }
    })()
  }, [])

  return (
    <>
      <RideView
        container={container}
        basemap={basemap}
        onOpenSetup={() => setSetupOpen(true)}
      />
      {needsSetup === true && (
        <RegionPicker
          basemap={basemap}
          onDone={() => setNeedsSetup(false)}
          onOpenSetup={() => setSetupOpen(true)}
        />
      )}
      {setupOpen && <SetupView basemap={basemap} onClose={() => setSetupOpen(false)} />}
    </>
  )
}
