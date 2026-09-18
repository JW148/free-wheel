import { useCallback, useEffect, useState } from 'react'
import { formatDistance, formatDuration } from './gpx'
import { formatElapsed } from './format'
import { profileById, RECORDED_TRACK } from './profiles'
import {
  byNewest,
  deleteEntry,
  filterEntries,
  libraryAvailable,
  listRides,
  listRoutes,
  putEntry,
  renamed,
  rideTotals,
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
 * Rendered inside `SavedScreen`, which owns the title and the way back — to the list while an
 * entry is open, and to the map when it is not. This owns the list, the filter, and the detail
 * each row opens into.
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
 * ## A row opens; the actions live inside
 *
 * Every row used to carry three buttons — Load, Export, Delete — which is Delete a thumb-width
 * from the thing you meant to ride, on a list you scroll. Now the row is one target that opens
 * the entry, and the actions are on a screen where nothing is moving and there is room to name
 * them. It also made the two kinds consistent: a ride opened and a route did not, for no
 * reason a rider could see.
 *
 * ## What each kind offers
 *
 * A **route** can be put back on the map and ridden. A **ride** is two things: a *record* — the
 * figures the finish sheet showed, which used to vanish with that sheet — and a *line on the
 * map*, a road you found and liked, which you can follow again without the router being asked
 * to guess at it.
 *
 * ## The thumbnail
 *
 * A shape, not a map. Forty-eight points normalised into a 52 px box is enough to tell a loop
 * from an out-and-back from a point-to-point at a glance, which is what actually identifies a
 * route in a list — far more than a name a rider did not bother to type. It is drawn in the
 * entry's own colour, so the shape in the list and the line on the map are the same object.
 */
export default function RouteLibrary({
  onLoad,
  onLoadTrack,
  reloadKey,
  openId,
  onOpen,
}: {
  /** Puts a saved route back on the map, ready to ride. */
  onLoad: (entry: SavedRoute) => void
  /** Puts a recorded ride's own track back on the map, to be followed as it was ridden. */
  onLoadTrack: (entry: SavedRide) => void
  /** Changing this reloads the list — after a save, the new entry has to appear. */
  reloadKey: number
  /**
   * The entry whose detail is open, by id — not by object, so a refresh keeps it fresh.
   *
   * Owned by `SavedScreen` rather than here, because the screen's own back arrow is the way
   * out of the detail. It used to draw a second one: a `‹ Saved` button inside the list, an
   * inch below the `‹` in the header, and the two did different things. One level, one way
   * back.
   */
  openId: string | null
  onOpen: (id: string | null) => void
}) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [filter, setFilter] = useState<LibraryFilter>('all')

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
    if (openId === entry.id) onOpen(null)
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

  if (entries === null) {
    return <p className="section-label">Loading saved routes…</p>
  }

  const open = entries.find((entry) => entry.id === openId)

  if (open) {
    return (
      <EntryDetail
        key={open.id}
        entry={open}
        onRide={() => (open.kind === 'route' ? onLoad(open) : onLoadTrack(open))}
        onRename={(name) => void rename(open, name)}
        onDelete={() => void remove(open)}
        problem={problem}
      />
    )
  }

  const shown = filterEntries(entries, filter)
  const rides = entries.filter((entry): entry is SavedRide => entry.kind === 'ride')

  return (
    <>
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

      {problem && <p className="warn">{problem}</p>}

      {/* Only where it is the answer to the question being asked. On the All list it would be a
          total that describes half the rows, and on Planned it describes none of them. */}
      {filter === 'ride' && rides.length > 0 && <Totals rides={rides} />}

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
            <button
              type="button"
              className="library-row"
              onClick={() => onOpen(entry.id)}
              aria-label={`Open ${entry.name}`}
            >
              <Thumbnail coords={entry.preview} colour={colourOf(entry)} />
              <span className="library-text">
                <span className="library-name">{entry.name}</span>
                <span className="library-figures">
                  {entry.kind === 'route' ? routeFigures(entry) : rideFigures(entry)}
                </span>
                <span className="library-tag" data-kind={entry.kind}>
                  {entry.kind === 'route' ? 'Planned' : 'Ridden'}
                </span>
              </span>
              <ChevronRightIcon />
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Everything ridden, added up.
 *
 * Two rows: the month, then all of it. The month first, because it is the one that changes and
 * therefore the one being looked for — a lifetime total is a fact you check twice a year.
 *
 * Time is moving time rather than elapsed, which is the figure a rider means by "I was out for
 * three hours" minus the café. `RideStats` makes the same choice for one ride, and the two have
 * to agree or the summary of a ride and the total it lands in describe different things.
 */
function Totals({ rides }: { rides: SavedRide[] }) {
  const { all, month, monthLabel } = rideTotals(rides)
  return (
    <div className="totals">
      <TotalRow label={monthLabel} totals={month} />
      <TotalRow label="All time" totals={all} />
    </div>
  )
}

function TotalRow({ label, totals }: { label: string; totals: ReturnType<typeof rideTotals>['all'] }) {
  return (
    <div className="totals-row">
      <span className="totals-label">{label}</span>
      <span className="totals-figures">
        {totals.rides === 0 ? (
          'Nothing yet'
        ) : (
          <>
            <strong>{formatDistance(totals.distanceM)}</strong>
            {` · ${Math.round(totals.ascentM)} m up · ${formatElapsed(totals.movingS)} · `}
            {totals.rides === 1 ? '1 ride' : `${totals.rides} rides`}
          </>
        )}
      </span>
    </div>
  )
}

/**
 * One saved thing: its figures, its name, and what can be done with it.
 *
 * Both kinds share this because they share nearly everything — a name, an export, a delete,
 * and one button that puts it on the map. What differs is the middle: a ride carries the six
 * figures `RideStats` draws, and a route carries the line it was computed as.
 */
function EntryDetail({
  entry,
  onRide,
  onRename,
  onDelete,
  problem,
}: {
  entry: LibraryEntry
  onRide: () => void
  onRename: (name: string) => void
  onDelete: () => void
  problem: string | null
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(entry.name)

  return (
    <>
      <div className="library-detail-title">
        <h2>{entry.name}</h2>
        <p>
          {entry.kind === 'ride'
            ? rideWhen(entry.summary.startedAt)
            : `${profileById(entry.profile).plain} · ${routeFigures(entry)}`}
        </p>
      </div>

      {entry.kind === 'ride' ? (
        <RideStats summary={entry.summary} />
      ) : (
        <dl className="detail-stats">
          <div>
            <dt>distance</dt>
            <dd>{formatDistance(entry.distanceM)}</dd>
          </div>
          <div>
            <dt>moving</dt>
            <dd>{entry.timeS !== null ? formatDuration(entry.timeS) : '—'}</dd>
          </div>
          <div>
            <dt>climbing</dt>
            <dd>{Math.round(entry.ascentM)} m</dd>
          </div>
        </dl>
      )}

      <button type="button" className="primary" onClick={onRide}>
        {entry.kind === 'route' ? 'Put it on the map' : 'Ride this track'}
      </button>

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
                setName(entry.name)
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
            onClick={() => void shareGpx(entry.gpx, gpxFilename(entry.kind, entry.savedAt))}
          >
            Export GPX
          </button>
          <button type="button" className="danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}

      {problem && (
        <p className="warn" role="alert">
          {problem}
        </p>
      )}
    </>
  )
}

/**
 * The colour a saved thing is drawn in.
 *
 * A route takes its profile's, so the thumbnail in the list and the line it will draw on the
 * map are the same colour. A ride takes the recorded-track orange for the same reason — it is
 * what it will be drawn as when it goes back on the map.
 */
function colourOf(entry: LibraryEntry): string {
  return entry.kind === 'route' ? profileById(entry.profile).colour : RECORDED_TRACK.colour
}

function routeFigures(entry: SavedRoute): string {
  return [
    formatDistance(entry.distanceM),
    entry.timeS !== null ? formatDuration(entry.timeS) : null,
    `${Math.round(entry.ascentM)} m up`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function rideFigures(entry: SavedRide): string {
  return [
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
function Thumbnail({ coords, colour }: { coords: [number, number][]; colour: string }) {
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
      const x = ((xs[i] - minX) / scale + offsetX) * 42 + 5
      const y = ((ys[i] - minY) / scale + offsetY) * 42 + 5
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' L')

  return (
    <svg className="library-thumb" viewBox="0 0 52 52" aria-hidden="true">
      <path
        d={`M${path}`}
        fill="none"
        stroke={colour}
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
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
