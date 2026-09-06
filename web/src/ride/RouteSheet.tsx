import { useState } from 'react'
import { PROFILES, type useRoute } from './useRoute'

/**
 * The action bar along the bottom, and the panel it opens into.
 *
 * Collapsed it is a single thumb-height row — profile, point count, and the one action worth
 * taking. Expanded it adds the things you only need while planning: the waypoint list and
 * the export. Nothing here is more than one tap from the map, because on a bike everything
 * competes with looking where you are going.
 */
export default function RouteSheet({ plan }: { plan: ReturnType<typeof useRoute> }) {
  const [open, setOpen] = useState(false)
  const profile = PROFILES.find((p) => p.id === plan.profile) ?? PROFILES[0]
  const canRoute = plan.waypoints.length >= 2 && !plan.routing

  return (
    <section className="sheet" data-open={open ? 'yes' : 'no'}>
      <div className="sheet-bar">
        <button
          type="button"
          className="sheet-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="sheet-profile">{profile.label}</span>
          <span className="sheet-count">
            {plan.waypoints.length === 0
              ? 'no points'
              : `${plan.waypoints.length} point${plan.waypoints.length === 1 ? '' : 's'}`}
          </span>
        </button>

        {plan.routing ? (
          <button type="button" className="primary busy" onClick={plan.cancel}>
            Stop
          </button>
        ) : (
          <button type="button" className="primary" disabled={!canRoute} onClick={() => void plan.run()}>
            {plan.route ? 'Reroute' : 'Find route'}
          </button>
        )}
      </div>

      {open && (
        <div className="sheet-body">
          {plan.warning && <p className="warn">{plan.warning}</p>}

          <fieldset className="profiles">
            <legend>Riding style</legend>
            {PROFILES.map((option) => (
              <label key={option.id} data-selected={option.id === plan.profile ? 'yes' : 'no'}>
                <input
                  type="radio"
                  name="profile"
                  value={option.id}
                  checked={option.id === plan.profile}
                  onChange={() => plan.setProfile(option.id)}
                />
                <span className="profile-label">{option.label}</span>
                <span className="profile-note">{option.note}</span>
              </label>
            ))}
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
            <button type="button" onClick={() => void exportGpx(plan.gpx)} disabled={!plan.gpx}>
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
async function exportGpx(gpx: string | null): Promise<void> {
  if (!gpx) return
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const file = new File([gpx], `free-wheel-${stamp}.gpx`, { type: 'application/gpx+xml' })

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
