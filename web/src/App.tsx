import { useRef, useState } from 'react'
import RideView from './ride/RideView'
import SetupView from './setup/SetupView'
import { useMapLibre } from './ride/useMapLibre'
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

  return (
    <>
      <RideView
        container={container}
        basemap={basemap}
        onOpenSetup={() => setSetupOpen(true)}
      />
      {setupOpen && <SetupView basemap={basemap} onClose={() => setSetupOpen(false)} />}
    </>
  )
}
