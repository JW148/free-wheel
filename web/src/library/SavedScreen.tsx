import RouteLibrary from '../ride/RouteLibrary'
import type { SavedRide, SavedRoute } from '../ride/library'

/**
 * Saved routes and rides, as a screen rather than a drawer view.
 *
 * ## Why it was promoted out of the drawer
 *
 * The drawer is the surface you *plan on*: it sits over the map because everything in it
 * describes a line you can see behind it. The library describes lines that are not on the map
 * at all, so there is nothing behind it worth seeing through to — it was a document wearing a
 * sheet's clothes, in a drawer already carrying two other views.
 *
 * As a screen it also gets the room the list wants: a filter, a 52 px thumbnail per row, and
 * a name that is not competing with a route's figures for the same 390 px.
 *
 * ## It is an overlay, never a replacement
 *
 * Same rule as Setup, and for the same reason. Unmounting the ride screen would take the map
 * with it, dropping its OPFS handles and its whole tile cache — and loading a route from here
 * puts it straight back onto that map. `RideView` keeps rendering underneath; this covers it.
 */
export default function SavedScreen({
  onClose,
  onLoad,
  onLoadTrack,
  reloadKey,
}: {
  onClose: () => void
  /** Puts a saved route back on the map. Closing is the caller's decision, not this one's. */
  onLoad: (entry: SavedRoute) => void
  /** Puts a recorded ride's own track back on the map, to be followed as it was ridden. */
  onLoadTrack: (entry: SavedRide) => void
  /** Changing this reloads the list — after a save, the new entry has to appear. */
  reloadKey: number
}) {
  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="screen-back" onClick={onClose} aria-label="Back to the map">
          <ChevronLeftIcon />
        </button>
        <h1>Saved</h1>
      </header>

      <div className="screen-body">
        <RouteLibrary onLoad={onLoad} onLoadTrack={onLoadTrack} reloadKey={reloadKey} />
      </div>

      <p className="screen-foot">Everything here lives on this phone only.</p>
    </div>
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
