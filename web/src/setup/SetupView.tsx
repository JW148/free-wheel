import { useCallback, useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import DiagnosticsPanel from './DiagnosticsPanel'
import MapsScreen from './MapsScreen'
import RiderPanel from './RiderPanel'
import { queueSummary } from './downloadQueue'
import { useDownloads } from './downloadStore'
import type { Rider } from '../ride/useRider'

/**
 * Everything that is not riding: the maps on this phone, the rider, and the engine harness.
 *
 * Split in three, and the split is by *when you open it*. **Maps** is what a rider needs before
 * a ride and will open on the day. **Rider** is set once and then almost never — a weight, a
 * bike, a riding position — and it is the input to every physical estimate the ride screen
 * makes. **Diagnostics** is the spike harness, which is invaluable when something is wrong and
 * pure noise when it is not. Keeping the parity check reachable in the shipping app is
 * deliberate: it is the project's regression net, and a net you have to rebuild to use does not
 * get used.
 *
 * ## It is also the first-run screen
 *
 * A phone with nothing downloaded opens straight into this, on Maps, with `gate` set. That is
 * one screen rather than two: the old arrangement had a full-screen region picker that existed
 * only until the first download and then became permanently unreachable, so a rider who wanted
 * a second region had no way back to the thing that had offered them the first. Here the way in
 * and the way back are the same door.
 *
 * The gate is not a wall. Riding genuinely needs data, but a rider is allowed to look around
 * first, and a phone that cannot reach the mirror must never be stuck behind a screen with
 * nothing on it to act on — so the header's button always lets them out. It just changes what
 * it says depending on whether leaving means abandoning anything.
 */
export default function SetupView({
  basemap,
  rider,
  gate,
  onClose,
}: {
  basemap: ReturnType<typeof useMapLibre>
  rider: Rider
  /** This phone has nothing to ride on, so Maps opens first and the exit is worded for it. */
  gate: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('maps')
  const [installedCount, setInstalledCount] = useState<number | null>(null)
  const jobs = useDownloads()
  const queue = queueSummary(jobs)

  // Stable, because `MapsScreen` reports through it from an effect: a fresh arrow every render
  // would make that effect fire on every render of this component.
  const onInstalledChange = useCallback((count: number) => setInstalledCount(count), [])

  const ready = !gate || (installedCount ?? 0) > 0

  return (
    <div className="setup">
      <header className="setup-header">
        {/* The title names the screen, not the rider's situation. "Welcome" belongs to the
            first run of the *Maps* tab and used to follow them into Rider and Diagnostics,
            where it was a greeting with nothing to do with what was on screen. */}
        <h1>{gate && !ready && tab === 'maps' ? 'Welcome' : 'Setup'}</h1>
        <button type="button" className="setup-close" onClick={onClose}>
          {ready ? 'Done' : 'Not now'}
        </button>
      </header>

      {/* A queue that outlives this screen deserves to be visible from anywhere in it — a rider
          who wandered into Rider settings while 400 MB arrives should not have to guess. */}
      {queue && (
        <p className="setup-queue" role="status">
          <span className="setup-queue-dot" aria-hidden="true" />
          {queue.line}
        </p>
      )}

      {/* One control with a current position, not three buttons to decide between. The
          indicator is placed from `--tab`; see `.setup-tabs` in `App.css`. */}
      <nav
        className="setup-tabs"
        style={
          {
            '--tab': TABS.findIndex(([id]) => id === tab),
            '--tab-count': TABS.length,
          } as React.CSSProperties
        }
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            data-selected={tab === id ? 'yes' : 'no'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main>
        {gate && !ready && tab === 'maps' && (
          <p className="setup-intro">
            free-wheel plans and follows routes with the network off, so the map and the road
            data have to be on the phone. Pick the areas you ride in and it fetches both.
          </p>
        )}
        {tab === 'maps' ? (
          <MapsScreen basemap={basemap} onInstalledChange={onInstalledChange} />
        ) : tab === 'rider' ? (
          <RiderPanel rider={rider} />
        ) : (
          <DiagnosticsPanel basemap={basemap} />
        )}
      </main>
    </div>
  )
}

type Tab = 'maps' | 'rider' | 'diagnostics'

const TABS: [Tab, string][] = [
  ['maps', 'Maps'],
  ['rider', 'Rider'],
  ['diagnostics', 'Diagnostics'],
]
