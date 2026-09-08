import { useCallback, useEffect, useState } from 'react'
import { formatDistance, formatDuration } from './gpx'
import { formatElapsed } from './format'
import { profileById } from './profiles'
import {
  byNewest,
  deleteEntry,
  filterEntries,
  libraryAvailable,
  listRides,
  listRoutes,
  putEntry,
  renamed,
  type LibraryEntry,
  type LibraryFilter,
  type SavedRide,
  type SavedRoute,
} from './library'
import RideStats, { rideWhen } from './RideStats'
import { gpxFilename, shareGpx } from './share'

/**
 * Saved routes and finished rides.
 *
 * ## One list, with a filter over it
 *
 * They are the same object to a rider — "a thing I did, or a thing I mean to do" — and the
 * useful ordering is by *when*, across both, which is why `all` is the default and the sort is
 * shared. What the first version got wrong was assuming that made a filter unnecessary. Rides
 * accumulate: a fortnight of commutes pushes the route planned for Saturday off the bottom of
 * the list, and then the ordering that made the list easy to read makes the one thing in it
 * you were looking for impossible to find. Three chips, no navigation.
 *
 * ## What each kind offers
 *
 * A **route** can be loaded onto the map and ridden — one tap, because that is the only thing
 * anyone does with one.
 *
 * A **ride** has already happened, and it turns out to be two things rather than one. It is a
 * *record*: the figures the finish sheet showed, which used to vanish the moment that sheet
 * was dismissed and are now a tap away for as long as the ride is kept. And it is a *line on
 * the map*: a road you found and liked, which you can put back and follow, without the
 * router's opinion getting involved. So a ride row opens, and its detail carries both.
 *
 * ## The thumbnail
 *
 * A shape, not a map. Forty-eight points normalised into a 44 px box is enough to tell a loop
 * from an out-and-back from a point-to-point at a glance, which is what actually identifies a
 * route in a list — far more than a name a rider did not bother to type.
 */
export default function RouteLibrary({
  onLoad,
  onLoadTrack,
  reloadKey,
}: {
  /** Puts a saved route back on the map, ready to ride. */
  onLoad: (entry: SavedRoute) => void
  /** Puts a recorded ride's own track back on the map, to be followed as it was ridden. */
  onLoadTrack: (entry: SavedRide) => void
  /** Changing this reloads the list — after a save, the new entry has to appear. */
  reloadKey: number
}) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [filter, setFilter] = useState<LibraryFilter>('all')
  /** The ride whose figures are open, by id — not by object, so a refresh keeps it fresh. */
  const [openRide, setOpenRide] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!libraryAvailable()) {
      setProblem('This browser has no IndexedDB, so routes cannot be saved.')
      setEntries([])
      return
    }
    try {
      const [routes, rides] = await Promise.all([listRoutes(), listRides()])
      setEntries(byNewest<LibraryEntry>([...routes, ...rides]))
      setProblem(null)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
      setEntries([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, reloadKey])

  const remove = async (entry: LibraryEntry) => {
    // A blocked database, or a second tab mid-upgrade. Silently leaving the row in place reads
    // as a dead button; `refresh` has said so from the start and this had not. The message is
    // set *after* the refresh, because a successful refresh clears it.
    let failure: string | null = null
    try {
      await deleteEntry(entry.kind, entry.id)
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
    if (openRide === entry.id) setOpenRide(null)
    await refresh()
    if (failure) setProblem(failure)
  }

  const rename = async (entry: LibraryEntry, name: string) => {
    let failure: string | null = null
    try {
      await putEntry(renamed(entry, name))
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
    await refresh()
    if (failure) setProblem(failure)
  }

  if (entries === null) return <p className="section-label">Loading saved routes…</p>

  const open = entries.find((entry) => entry.id === openRide && entry.kind === 'ride') as
    | SavedRide
    | undefined

  if (open) {
    return (
      <RideDetail
        key={open.id}
        ride={open}
        onBack={() => setOpenRide(null)}
        onRide={() => onLoadTrack(open)}
        onRename={(name) => void rename(open, name)}
        onDelete={() => void remove(open)}
        problem={problem}
      />
    )
  }

  const shown = filterEntries(entries, filter)

  return (
    <div className="library">
      <div className="library-head">
        <p className="section-label">Routes and rides</p>
        <div className="segmented" role="group" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['route', 'Planned'],
              ['ride', 'Ridden'],
            ] as [LibraryFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="segment"
              data-active={filter === value ? 'yes' : 'no'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {problem && <p className="warn">{problem}</p>}

      {entries.length === 0 && !problem && (
        <p className="warn">
          Nothing saved yet. Plan a route, choose it, and Save puts it here — it stays on the
          phone and works with the network off. Rides you record are kept here too.
        </p>
      )}

      {entries.length > 0 && shown.length === 0 && (
        <p className="warn">
          {filter === 'route'
            ? 'No planned routes yet — only rides you have recorded.'
            : 'No recorded rides yet. Start a ride and it will be kept here when you finish.'}
        </p>
      )}

      <ul className="library-list">
        {shown.map((entry) => (
          <li key={entry.id}>
            <Thumbnail coords={entry.preview} />
            <div className="library-text">
              <span className="library-name">{entry.name}</span>
              <span className="library-figures">
                {entry.kind === 'route' ? routeFigures(entry) : rideFigures(entry)}
              </span>
            </div>
            <div className="library-actions">
              {entry.kind === 'route' ? (
                <button type="button" className="primary" onClick={() => onLoad(entry)}>
                  Load
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => setOpenRide(entry.id)}>
                  Open
                </button>
              )}
              <button
                type="button"
                onClick={() => void shareGpx(entry.gpx, gpxFilename(entry.kind, entry.savedAt))}
                aria-label={`Export ${entry.name}`}
              >
                Export
              </button>
              <button
                type="button"
                onClick={() => void remove(entry)}
                aria-label={`Delete ${entry.name}`}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One recorded ride: its figures, its name, and the two things you can do with it.
 *
 * The figures are the finish sheet's, from the same component, because they are the same
 * figures — see `RideStats`. What is new here is the second use of a ride: **Ride this track**
 * puts the line back on the map to be followed, which is what makes a good route you stumbled
 * on repeatable without the router being asked to guess at it again.
 */
function RideDetail({
  ride,
  onBack,
  onRide,
  onRename,
  onDelete,
  problem,
}: {
  ride: SavedRide
  onBack: () => void
  onRide: () => void
  onRename: (name: string) => void
  onDelete: () => void
  problem: string | null
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(ride.name)

  return (
    <div className="library">
      <div className="drawer-head">
        <button type="button" className="drawer-back" onClick={onBack} aria-label="Back to the list">
          <ChevronLeftIcon />
        </button>
        <div className="ride-detail-title">
          <span className="library-name">{ride.name}</span>
          <span className="library-figures">{rideWhen(ride.summary.startedAt)}</span>
        </div>
        <button type="button" className="primary" onClick={onRide}>
          Ride it
        </button>
      </div>

      <RideStats summary={ride.summary} />

      {/* The name field is here and not on the riding screen, and that is deliberate: a text
          input on a moving bike is what brings up iOS's shake-to-undo alert. See
          `RideSummary.tsx`. */}
      {naming ? (
        <>
          <label className="named-save">
            <span className="section-label">Call it something</span>
            <input
              type="text"
              value={name}
              placeholder="Tuesday evening loop"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="sheet-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                onRename(name)
                setNaming(false)
              }}
            >
              Save the name
            </button>
            <button
              type="button"
              onClick={() => {
                setName(ride.name)
                setNaming(false)
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="sheet-actions">
          <button type="button" onClick={() => setNaming(true)}>
            Rename
          </button>
          <button
            type="button"
            onClick={() => void shareGpx(ride.gpx, gpxFilename('ride', ride.savedAt))}
          >
            Export GPX
          </button>
          <button type="button" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}

      {problem && (
        <p className="warn" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

function routeFigures(entry: SavedRoute): string {
  return [
    profileById(entry.profile).label,
    formatDistance(entry.distanceM),
    entry.timeS !== null ? formatDuration(entry.timeS) : null,
    `${Math.round(entry.ascentM)} m up`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function rideFigures(entry: SavedRide): string {
  return [
    'Ridden',
    formatDistance(entry.summary.distanceM),
    formatElapsed(entry.summary.movingS),
    `${Math.round(entry.summary.ascentM)} m up`,
  ].join(' · ')
}

/**
 * The route's shape, normalised into a square.
 *
 * Longitude is scaled by cos(latitude) before fitting, so a route is not stretched sideways —
 * at 56° north a degree of longitude is barely half a degree of latitude, and without the
 * correction every Scottish route renders as a wide flat smear.
 *
 * The aspect ratio is *preserved* within the box rather than filling it, because the
 * proportion is most of what identifies a route: a long thin out-and-back stretched to fill a
 * square looks exactly like a compact loop.
 */
function Thumbnail({ coords }: { coords: [number, number][] }) {
  if (coords.length < 2) return <span className="library-thumb" aria-hidden="true" />

  const midLat = coords[Math.floor(coords.length / 2)][1]
  const scaleX = Math.cos((midLat * Math.PI) / 180)
  const xs = coords.map((c) => c[0] * scaleX)
  const ys = coords.map((c) => -c[1])
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)]
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)]
  const scale = Math.max(maxX - minX, maxY - minY) || 1e-9
  const offsetX = (1 - (maxX - minX) / scale) / 2
  const offsetY = (1 - (maxY - minY) / scale) / 2

  const path = coords
    .map((_, i) => {
      const x = ((xs[i] - minX) / scale + offsetX) * 36 + 4
      const y = ((ys[i] - minY) / scale + offsetY) * 36 + 4
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' L')

  return (
    <svg className="library-thumb" viewBox="0 0 44 44" aria-hidden="true">
      <path
        d={`M${path}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}
