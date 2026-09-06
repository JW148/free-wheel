import { useEffect, useRef, useState } from 'react'
import RideView from './ride/RideView'
import SetupView from './setup/SetupView'
import FirstRun from './setup/FirstRun'
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
        const [archives, tiles] = await Promise.all([
          sharedEngine().installedBasemaps(),
          sharedEngine().installedTiles(),
        ])
        setNeedsSetup(archives.length === 0 || tiles.length === 0)
      } catch {
        // If the engine cannot even be asked, the guided flow is the more useful screen —
        // it is the one that explains what the app needs.
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
        <FirstRun basemap={basemap} onDone={() => setNeedsSetup(false)} />
      )}
      {setupOpen && <SetupView basemap={basemap} onClose={() => setSetupOpen(false)} />}
    </>
  )
}
