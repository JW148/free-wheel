import { useCallback, useEffect, useState } from 'react'
import { formatDistance, formatDuration } from './gpx'
import { formatElapsed } from './format'
import { profileById } from './profiles'
import {
  byNewest,
  deleteEntry,
  libraryAvailable,
  listRides,
  listRoutes,
  type LibraryEntry,
  type SavedRide,
  type SavedRoute,
} from './library'
import { gpxFilename, shareGpx } from './share'

/**
 * Saved routes and finished rides, in one list.
 *
 * ## Why one list and not two tabs
 *
 * They are the same object to a rider: "a thing I did or a thing I mean to do", and the useful
 * ordering is by *when*, across both. A ride from Sunday and the route planned for Saturday sit
 * next to each other because that is where a rider looks for them. Two tabs would mean deciding
 * which one you are in before you can look, which is exactly the decision the list should be
 * making unnecessary.
 *
 * They are distinguished by what they offer: a route can be **loaded** onto the map and
 * ridden; a ride has already happened and can only be exported or deleted. So the row's
 * primary action names the difference rather than a tab bar doing it.
 *
 * ## The thumbnail
 *
 * A shape, not a map. Forty-eight points normalised into a 44 px box is enough to tell a loop
 * from an out-and-back from a point-to-point at a glance, which is what actually identifies a
 * route in a list — far more than a name a rider did not bother to type.
 */
export default function RouteLibrary({
  onLoad,
  reloadKey,
}: {
  /** Puts a saved route back on the map, ready to ride. */
  onLoad: (entry: SavedRoute) => void
  /** Changing this reloads the list — after a save, the new entry has to appear. */
  reloadKey: number
}) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

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
    await deleteEntry(entry.kind, entry.id)
    await refresh()
  }

  if (entries === null) return <p className="section-label">Loading saved routes…</p>

  return (
    <div className="library">
      <p className="section-label">Routes and rides</p>

      {problem && <p className="warn">{problem}</p>}

      {entries.length === 0 && !problem && (
        <p className="warn">
          Nothing saved yet. Plan a route, choose it, and Save puts it here — it stays on the
          phone and works with the network off.
        </p>
      )}

      <ul className="library-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <Thumbnail coords={entry.preview} />
            <div className="library-text">
              <span className="library-name">{entry.name}</span>
              <span className="library-figures">
                {entry.kind === 'route' ? routeFigures(entry) : rideFigures(entry)}
              </span>
            </div>
            <div className="library-actions">
              {entry.kind === 'route' && (
                <button type="button" className="primary" onClick={() => onLoad(entry)}>
                  Load
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void shareGpx(entry.gpx, gpxFilename(entry.kind, entry.savedAt))
                }
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
