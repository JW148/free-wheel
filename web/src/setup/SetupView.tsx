import { useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import BasemapPanel from '../map/BasemapPanel'
import TilesPanel from '../engine/TilesPanel'
import DiagnosticsPanel from './DiagnosticsPanel'
import RiderPanel from './RiderPanel'
import type { Rider } from '../ride/useRider'

/**
 * Everything that is not riding: importing data, and proving the engine still works.
 *
 * Split in three, and the split is by *when you open it*. **Data** is what a rider needs
 * before a ride and will open on the day. **Rider** is set once and then almost never — a
 * weight, a bike, a riding position — and it is the input to every physical estimate the ride
 * screen makes. **Diagnostics** is the spike harness — the parity corpus, the benchmarks, the
 * environment dump — which is invaluable when something is wrong and pure noise when it is
 * not. Keeping the parity check reachable in the shipping app is deliberate: it is the
 * project's regression net, and a net you have to rebuild to use does not get used.
 */
export default function SetupView({
  basemap,
  rider,
  onClose,
}: {
  basemap: ReturnType<typeof useMapLibre>
  rider: Rider
  onClose: () => void
}) {
  const [tab, setTab] = useState<'data' | 'rider' | 'diagnostics'>('data')

  return (
    <div className="setup">
      <header className="setup-header">
        <h1>Setup</h1>
        <button type="button" className="setup-close" onClick={onClose}>
          Done
        </button>
      </header>

      <nav className="setup-tabs">
        <button type="button" data-selected={tab === 'data' ? 'yes' : 'no'} onClick={() => setTab('data')}>
          Maps and data
        </button>
        <button
          type="button"
          data-selected={tab === 'rider' ? 'yes' : 'no'}
          onClick={() => setTab('rider')}
        >
          Rider
        </button>
        <button
          type="button"
          data-selected={tab === 'diagnostics' ? 'yes' : 'no'}
          onClick={() => setTab('diagnostics')}
        >
          Diagnostics
        </button>
      </nav>

      <main>
        {tab === 'data' ? (
          <>
            <BasemapPanel basemap={basemap} />
            <TilesPanel />
          </>
        ) : tab === 'rider' ? (
          <RiderPanel rider={rider} />
        ) : (
          <DiagnosticsPanel basemap={basemap} />
        )}
      </main>
    </div>
  )
}
