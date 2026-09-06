import { useState } from 'react'
import { PROFILES, profileById, type useRoute } from './useRoute'
import { formatDistance, formatDuration } from './gpx'
import ElevationProfile from './ElevationProfile'

/**
 * The action bar along the bottom, and the panel it opens into.
 *
 * Collapsed it is a single thumb-height row: what is selected, and the one action worth
 * taking. Expanded it adds planning — the profile picker, the elevation profile, the
 * waypoint list, the export. On a bike everything competes with looking where you are going,
 * so nothing here is more than one tap from the map.
 */
export default function RouteSheet({ plan }: { plan: ReturnType<typeof useRoute> }) {
  const [open, setOpen] = useState(false)
  const results = Object.keys(plan.routes)
  const comparing = plan.selection.length > 1
  const canRoute = plan.waypoints.length >= 2 && plan.routing === null

  return (
    <section className="sheet">
      <div className="sheet-bar">
        <button
          type="button"
          className="sheet-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="sheet-profile">
            {comparing
              ? `Comparing ${plan.selection.length}`
              : profileById(plan.selection[0]).label}
          </span>
          <span className="sheet-count">
            {plan.routing
              ? `Routing ${profileById(plan.routing).label}…`
              : plan.waypoints.length === 0
                ? 'no points'
                : `${plan.waypoints.length} point${plan.waypoints.length === 1 ? '' : 's'}`}
          </span>
        </button>

        {plan.routing !== null ? (
          <button type="button" className="primary busy" onClick={plan.cancel}>
            Stop
          </button>
        ) : (
          <button type="button" className="primary" disabled={!canRoute} onClick={() => void plan.run()}>
            {results.length > 0 ? 'Reroute' : comparing ? 'Compare' : 'Find route'}
          </button>
        )}
      </div>

      {open && (
        <div className="sheet-body">
          {plan.warning && <p className="warn">{plan.warning}</p>}

          {plan.route && <ElevationProfile route={plan.route} />}

          <fieldset className="profiles">
            <legend className="section-label">
              Riding style{plan.selection.length > 1 && ' — tick several to compare'}
            </legend>
            {PROFILES.map((option) => {
              const result = plan.routes[option.id]
              const chosen = plan.selection.includes(option.id)
              return (
                <label
                  key={option.id}
                  data-selected={chosen ? 'yes' : 'no'}
                  onClick={() => result && plan.setFocused(option.id)}
                >
                  <input
                    type="checkbox"
                    checked={chosen}
                    onChange={() => plan.toggleProfile(option.id)}
                  />
                  <span className="profile-label">{option.label}</span>
                  <span className="profile-note">{option.note}</span>
                  {result ? (
                    <span className="profile-figure">
                      <strong>{formatDistance(result.distanceM)}</strong>
                      {formatDuration(result.timeS)} · {Math.round(result.ascendM)} m
                    </span>
                  ) : (
                    // The swatch is what ties a row to its line on the map. It shows even
                    // before a result exists, so the mapping is learnable rather than
                    // discovered after the fact.
                    <span
                      className="profile-swatch"
                      style={{ background: chosen ? option.colour : 'transparent' }}
                    />
                  )}
                </label>
              )
            })}
          </fieldset>

          {plan.waypoints.length > 0 && (
            <ol className="waypoints">
              {plan.waypoints.map((waypoint, index) => (
                <li key={waypoint.id}>
                  <span className="waypoint-role">
                    {index === 0
                      ? 'Start'
                      : index === plan.waypoints.length - 1
                        ? 'Finish'
                        : `Via ${index}`}
                  </span>
                  <span className="waypoint-coords">
                    {waypoint.lat.toFixed(4)}, {waypoint.lon.toFixed(4)}
                  </span>
                  <button
                    type="button"
                    onClick={() => plan.removeWaypoint(waypoint.id)}
                    aria-label={`Remove point ${index + 1}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          )}

          <div className="sheet-actions">
            <button type="button" onClick={plan.clear} disabled={plan.waypoints.length === 0}>
              Clear route
            </button>
            <button
              type="button"
              onClick={() => void exportGpx(plan.focusedGpx, plan.focused)}
              disabled={!plan.focusedGpx}
            >
              Export GPX
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Hands the GPX to the OS.
 *
 * `navigator.share` with a File is the one that matters on iOS — it puts the route into
 * Files, Mail, or another cycling app in two taps. The download fallback covers desktop,
 * where sharing a file is often unsupported.
 */
async function exportGpx(gpx: string | null, profile: string): Promise<void> {
  if (!gpx) return
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const file = new File([gpx], `free-wheel-${profile}-${stamp}.gpx`, {
    type: 'application/gpx+xml',
  })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'free-wheel route' })
      return
    } catch (error) {
      // A cancelled share sheet rejects. That is a choice, not a failure — fall through to
      // a download only if something actually went wrong.
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
  }

  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  URL.revokeObjectURL(url)
}
