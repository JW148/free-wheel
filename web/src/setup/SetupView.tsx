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
 * ## A list that pushes, not three tabs
 *
 * A tab strip is a control with a current position, and it is right when the three things are
 * views of one subject. These are not: the maps on the phone, the rider's weight, and an engine
 * parity harness have nothing to do with each other, and a strip across the top implied they
 * were peers you would move between. They are three separate places, and they are reached the
 * way separate places are reached — by going there and coming back.
 *
 * The split itself is by *when you open it*. **Maps** is what a rider needs before a ride and
 * will open on the day. **Rider** is set once and then almost never — a weight, a bike, a riding
 * position — and it is the input to every physical estimate the ride screen makes.
 * **Diagnostics** is the spike harness, which is invaluable when something is wrong and pure
 * noise when it is not, so it is a line of text at the foot rather than a third of the width.
 * Keeping the parity check reachable in the shipping app is deliberate: it is the project's
 * regression net, and a net you have to rebuild to use does not get used.
 *
 * ## It is also the first-run gate
 *
 * A phone with nothing downloaded opens straight onto Maps, with `gate` set. That is one screen
 * rather than two: the old arrangement had a full-screen region picker that existed only until
 * the first download and then became permanently unreachable, so a rider who wanted a second
 * region had no way back to the thing that had offered them the first. Here the way in and the
 * way back are the same door.
 *
 * The gate is not a wall. Riding genuinely needs data, but a rider is allowed to look around
 * first, and a phone that cannot reach the mirror must never be stuck behind a screen with
 * nothing on it to act on — so the way out is always there. It just changes what it says
 * depending on whether leaving means abandoning anything.
 */
export default function SetupView({
  basemap,
  rider,
  gate,
  openOn,
  onClose,
}: {
  basemap: ReturnType<typeof useMapLibre>
  rider: Rider
  /** This phone has nothing to ride on, so Maps opens first and the exit is worded for it. */
  gate: boolean
  /**
   * Which page to land on, for a caller that already knows what the rider came for.
   *
   * The search screen uses it: a rider who typed a town this phone has no map for and tapped
   * the region it is in should arrive at the regions, not at a menu with the word Maps on it.
   * Unlike `gate` it changes nothing else — the menu is still behind it, and back goes there.
   */
  openOn?: Page
  onClose: () => void
}) {
  /** `null` is the menu; anything else is a screen pushed on top of it. */
  const [page, setPage] = useState<Page | null>(gate ? 'maps' : (openOn ?? null))
  const [installedCount, setInstalledCount] = useState<number | null>(null)
  const jobs = useDownloads()
  const queue = queueSummary(jobs)

  // Stable, because `MapsScreen` reports through it from an effect: a fresh arrow every render
  // would make that effect fire on every render of this component.
  const onInstalledChange = useCallback((count: number) => setInstalledCount(count), [])

  const ready = !gate || (installedCount ?? 0) > 0
  /* On the gate there is no menu behind Maps to go back to, so back *is* the way out. */
  const back = gate ? onClose : () => setPage(null)

  if (page === 'maps') {
    return (
      <Screen title="Maps on this phone" onBack={back} backLabel={ready ? 'Done' : 'Not now'}>
        {queue && <Queue line={queue.line} />}
        {gate && !ready && (
          <p className="setup-intro">
            free-wheel plans and follows routes with the network off, so the map and the road
            data have to be on the phone. Pick the areas you ride in and it fetches both.
          </p>
        )}
        <MapsScreen basemap={basemap} onInstalledChange={onInstalledChange} />
      </Screen>
    )
  }

  if (page === 'rider') {
    return (
      <Screen title="You and the bike" onBack={() => setPage(null)}>
        <RiderPanel rider={rider} />
      </Screen>
    )
  }

  if (page === 'diagnostics') {
    return (
      <Screen title="Diagnostics" onBack={() => setPage(null)}>
        <DiagnosticsPanel basemap={basemap} />
      </Screen>
    )
  }

  return (
    <Screen title="Setup" onBack={onClose} backLabel="Done">
      {/* A queue that outlives this screen deserves to be visible from anywhere in it — a rider
          who wandered into the rider settings while 400 MB arrives should not have to guess. */}
      {queue && <Queue line={queue.line} />}

      <div className="setup-menu">
        <button type="button" className="setup-menu-row" onClick={() => setPage('maps')}>
          <span className="setup-menu-icon" aria-hidden="true">
            <MapIcon />
          </span>
          <span className="setup-menu-text">
            <strong>Maps on this phone</strong>
            <span>
              {installedCount === null
                ? 'The regions you can ride in, and their size'
                : installedCount === 0
                  ? 'Nothing downloaded yet'
                  : `${installedCount} region${installedCount === 1 ? '' : 's'} downloaded`}
            </span>
          </span>
          <ChevronRightIcon />
        </button>

        <button type="button" className="setup-menu-row" onClick={() => setPage('rider')}>
          <span className="setup-menu-icon" aria-hidden="true">
            <RiderIcon />
          </span>
          <span className="setup-menu-text">
            <strong>You and the bike</strong>
            <span>
              {rider.setup.riderKg + rider.setup.bikeKg} kg all in · the power estimate reads
              from here
            </span>
          </span>
          <ChevronRightIcon />
        </button>
      </div>

      <p className="setup-footer">
        Everything this app knows lives on this phone. There is no account and no server, so
        there is nothing to sign in to and nothing to sign out of.
      </p>

      <p className="setup-quiet">
        Diagnostics and engine parity check ·{' '}
        <button type="button" className="linklike" onClick={() => setPage('diagnostics')}>
          Open
        </button>
      </p>
    </Screen>
  )
}

type Page = 'maps' | 'rider' | 'diagnostics'

/**
 * The shell every Setup page shares with the Saved screen.
 *
 * `backLabel` is a word rather than a chevron where leaving means something other than "up one"
 * — on the gate, and on the menu itself, back is *out of Setup*, and a chevron would claim
 * there is a screen behind it.
 */
function Screen({
  title,
  onBack,
  backLabel,
  children,
}: {
  title: string
  onBack: () => void
  backLabel?: string
  children: React.ReactNode
}) {
  return (
    <div className="setup screen">
      <header className="screen-head">
        {backLabel ? (
          <>
            <h1>{title}</h1>
            <button type="button" className="setup-close" onClick={onBack}>
              {backLabel}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="screen-back" onClick={onBack} aria-label="Back to Setup">
              <ChevronLeftIcon />
            </button>
            <h1>{title}</h1>
          </>
        )}
      </header>
      <main className="screen-body">{children}</main>
    </div>
  )
}

function Queue({ line }: { line: string }) {
  return (
    <p className="setup-queue" role="status">
      <span className="setup-queue-dot" aria-hidden="true" />
      {line}
    </p>
  )
}

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z" />
      <path d="M9 4v13M15 6.5v13" />
    </svg>
  )
}

function RiderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="7" r="3" />
      <path d="M5 21v-1.5A5.5 5.5 0 0 1 10.5 14h3a5.5 5.5 0 0 1 5.5 5.5V21" />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" className="library-chevron" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}
