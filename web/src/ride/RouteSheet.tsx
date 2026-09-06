import { useState } from 'react'
import { Drawer } from 'vaul'
import { PROFILES, profileById, type useRoute } from './useRoute'
import { formatDistance, formatDuration } from './gpx'
import ElevationProfile from './ElevationProfile'

/**
 * The bottom bar, and the drawer it opens into.
 *
 * The bar is always there: what is selected, and the single action worth taking. Everything
 * else — the elevation profile, the profile picker, the waypoint list, export — lives in a
 * drawer you pull up and swipe away.
 *
 * ## Why vaul rather than a `max-height` transition
 *
 * The previous version was a flex child of the chrome layer that grew when opened. Two things
 * were wrong with that. Visibly, its height was capped in viewport units while its position
 * depended on the siblings above it, so on a phone it ran off the bottom of the screen.
 * Structurally, drag-to-dismiss done properly is velocity tracking, rubber-banding at the
 * limits, scroll/drag disambiguation inside the content, focus trapping and inert background
 * — all of which vaul already does correctly and none of which is interesting to rewrite.
 *
 * It portals to `document.body`, so it is not subject to the chrome layer's flexbox at all,
 * which is what makes the overflow impossible rather than merely fixed.
 */
export default function RouteSheet({
  plan,
  onStart,
}: {
  plan: ReturnType<typeof useRoute>
  onStart: () => void
}) {
  const [open, setOpen] = useState(false)
  const comparing = plan.selection.length > 1
  const routed = Object.keys(plan.routes).length > 0
  const canRoute = plan.waypoints.length >= 2 && plan.routing === null

  return (
    <>
      <div className="sheet-bar panel">
        <button
          type="button"
          className="sheet-toggle"
          onClick={() => setOpen(true)}
          aria-label="Route options"
        >
          <span className="sheet-profile">
            {comparing ? `Comparing ${plan.selection.length}` : profileById(plan.selection[0]).label}
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
        ) : routed ? (
          // Once there is a route, the useful action is riding it. Rerouting moves into the
          // drawer, where the things you would reroute *because of* already are.
          <button type="button" className="primary" onClick={onStart}>
            Start
          </button>
        ) : (
          <button type="button" className="primary" disabled={!canRoute} onClick={() => void plan.run()}>
            {comparing ? 'Compare' : 'Find route'}
          </button>
        )}
      </div>

      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="drawer-overlay" />
          <Drawer.Content className="drawer" aria-describedby={undefined}>
            <Drawer.Handle className="drawer-handle" />
            <div className="drawer-body">
              <div className="drawer-head">
                <Drawer.Title className="drawer-title">
                  {comparing ? `Comparing ${plan.selection.length} styles` : 'Route'}
                </Drawer.Title>
                <button
                  type="button"
                  className="primary"
                  disabled={!canRoute}
                  onClick={() => void plan.run()}
                >
                  {routed ? 'Reroute' : comparing ? 'Compare' : 'Find route'}
                </button>
              </div>

              {plan.warning && <p className="warn">{plan.warning}</p>}

              {plan.route && <ElevationProfile route={plan.route} />}

              <fieldset className="profiles">
                <legend className="section-label">Riding style — tick several to compare</legend>
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
                      <span className="profile-label">
                        {/* The swatch ties a row to its line on the map, and only appears
                            when there is more than one line to tell apart. */}
                        {comparing && (
                          <span className="profile-swatch" style={{ background: option.colour }} />
                        )}
                        {option.label}
                      </span>
                      <span className="profile-note">{option.note}</span>
                      {result && (
                        <span className="profile-figure">
                          <strong>{formatDistance(result.distanceM)}</strong>
                          {formatDuration(result.timeS)} · {Math.round(result.ascendM)} m
                        </span>
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
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
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
