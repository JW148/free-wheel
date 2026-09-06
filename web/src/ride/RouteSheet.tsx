import { Drawer } from 'vaul'
import { PROFILES, profileById } from './profiles'
import type { Plan } from './useRoute'
import { formatDistance, formatDuration } from './gpx'
import ElevationProfile from './ElevationProfile'
import ElevationCompare from './ElevationCompare'
import type { RouteSheetState } from './useRouteSheet'

/**
 * The bottom bar, and the drawer it opens into.
 *
 * The bar is always there: what is chosen, and the single action worth taking. Everything else
 * — the elevation profile, the profile picker, the waypoint list, export — lives in a drawer
 * you pull up and swipe away.
 *
 * ## Two views, one drawer
 *
 * *Compare* is the list: tick the styles you want, hit Compare, and each result gets a row.
 * *Detail* is one route: its figures, its elevation profile in its own colour, and the button
 * that starts the ride. Choosing — a tap on a line on the map, or on a row's figures here —
 * is what moves between them.
 *
 * They are two views of one `Drawer.Root` rather than two drawers. Stacking vaul on vaul
 * means two drag handlers, two overlays and two focus traps competing for the same touch, and
 * the back-and-forth here is navigation, not a new surface.
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
  sheet,
  onStart,
}: {
  plan: Plan
  sheet: RouteSheetState
  onStart: () => void
}) {
  const routeIds = Object.keys(plan.routes)
  const routed = routeIds.length > 0
  const comparing = plan.selection.length > 1
  const canRoute = plan.waypoints.length >= 2 && plan.routing === null
  const chosen = plan.route

  return (
    <>
      <div className="sheet-bar panel">
        <button
          type="button"
          className="sheet-toggle"
          onClick={sheet.openForPlan}
          aria-label="Route options"
        >
          {chosen && plan.chosen ? (
            <>
              <span className="sheet-profile">
                <span className="swatch" style={{ background: profileById(plan.chosen).colour }} />
                {profileById(plan.chosen).label}
              </span>
              <span className="sheet-count">
                {formatDistance(chosen.distanceM)}
                {chosen.timeS !== null && ` · ${formatDuration(chosen.timeS)}`}
                {` · ${Math.round(chosen.ascendM)} m`}
              </span>
            </>
          ) : (
            <>
              <span className="sheet-profile">
                {routed
                  ? `${routeIds.length} routes compared`
                  : comparing
                    ? `Comparing ${plan.selection.length} styles`
                    : profileById(plan.selection[0]).label}
              </span>
              <span className="sheet-count">
                {plan.routing
                  ? `Routing ${profileById(plan.routing).label}…`
                  : routed
                    ? 'Tap a line to choose'
                    : plan.waypoints.length === 0
                      ? 'no points'
                      : `${plan.waypoints.length} point${plan.waypoints.length === 1 ? '' : 's'}`}
              </span>
            </>
          )}
        </button>

        {plan.routing !== null ? (
          <button type="button" className="primary busy" onClick={plan.cancel}>
            Stop
          </button>
        ) : chosen ? (
          // Once a route is chosen, the useful action is riding it. Rerouting moves into the
          // drawer, where the things you would reroute *because of* already are.
          <button type="button" className="primary" onClick={onStart}>
            Start
          </button>
        ) : routed ? (
          // Routes exist but none is picked. The action is the decision, not the ride.
          <button type="button" className="primary" onClick={sheet.showCompare}>
            Choose
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!canRoute}
            onClick={() => void plan.run()}
          >
            {comparing ? 'Compare' : 'Find route'}
          </button>
        )}
      </div>

      <Drawer.Root open={sheet.open} onOpenChange={sheet.setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="drawer-overlay" />
          <Drawer.Content className="drawer" aria-describedby={undefined}>
            <Drawer.Handle className="drawer-handle" />
            <div className="drawer-body">
              {sheet.view === 'detail' && chosen && plan.chosen ? (
                <>
                  <div className="drawer-head">
                    <button
                      type="button"
                      className="drawer-back"
                      onClick={() => sheet.setView('compare')}
                      aria-label="Back to riding styles"
                    >
                      <ChevronLeftIcon />
                    </button>
                    <Drawer.Title className="drawer-title">
                      <span className="swatch" style={{ background: profileById(plan.chosen).colour }} />
                      {profileById(plan.chosen).label}
                    </Drawer.Title>
                    <button type="button" className="primary" onClick={onStart}>
                      Ride this
                    </button>
                  </div>

                  <dl className="detail-stats">
                    <div>
                      <dd>{formatDistance(chosen.distanceM)}</dd>
                      <dt>distance</dt>
                    </div>
                    <div>
                      <dd>{formatDuration(chosen.timeS)}</dd>
                      <dt>moving</dt>
                    </div>
                    <div>
                      <dd>{Math.round(chosen.ascendM)} m</dd>
                      <dt>climbing</dt>
                    </div>
                  </dl>

                  <ElevationProfile
                    route={chosen}
                    colour={profileById(plan.chosen).colour}
                    label={profileById(plan.chosen).label}
                  />

                  <Waypoints plan={plan} />

                  <div className="sheet-actions">
                    {/* Only where there is a comparison to go back to. With a lone route this
                        would just disable Start and explain nothing. */}
                    {plan.clearableChoice && (
                      <button type="button" onClick={sheet.clearChoice}>
                        Clear selection
                      </button>
                    )}
                    <button type="button" onClick={plan.clear}>
                      Clear route
                    </button>
                    <button
                      type="button"
                      onClick={() => void exportGpx(plan.chosenGpx, plan.chosen)}
                      disabled={!plan.chosenGpx}
                    >
                      Export GPX
                    </button>
                  </div>
                </>
              ) : (
                <>
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

                  {routed && !chosen && (
                    <p className="warn">
                      {routeIds.length} routes are on the map. Tap one — here or on the map — to
                      see its climbs and ride it.
                    </p>
                  )}

                  {/* Above the list, because the shapes are what the list's numbers cannot
                      show, and the decision is made looking at them. Renders nothing until
                      there are two routes to compare. */}
                  <ElevationCompare
                    routes={plan.routes}
                    chosen={plan.chosen}
                    onChoose={sheet.choose}
                  />

                  <fieldset className="profiles">
                    <legend className="section-label">
                      Riding style — tick several to compare
                    </legend>
                    {PROFILES.map((option) => {
                      const result = plan.routes[option.id]
                      const ticked = plan.selection.includes(option.id)
                      return (
                        <div
                          key={option.id}
                          className="profile-row"
                          data-selected={ticked ? 'yes' : 'no'}
                          data-chosen={plan.chosen === option.id ? 'yes' : 'no'}
                        >
                          <input
                            id={`profile-${option.id}`}
                            type="checkbox"
                            checked={ticked}
                            onChange={() => plan.toggleProfile(option.id)}
                          />
                          <label htmlFor={`profile-${option.id}`} className="profile-text">
                            <span className="profile-label">
                              {/* Ties a row to its line on the map. Every route now takes
                                  its profile's colour, including a lone one, so this is
                                  always meaningful. */}
                              <span className="swatch" style={{ background: option.colour }} />
                              {option.label}
                            </span>
                            <span className="profile-note">{option.note}</span>
                          </label>
                          {result && (
                            <button
                              type="button"
                              className="profile-pick"
                              onClick={() =>
                                plan.chosen === option.id
                                  ? sheet.clearChoice()
                                  : sheet.choose(option.id)
                              }
                              aria-label={
                                plan.chosen === option.id
                                  ? `Clear the ${option.label} selection`
                                  : `Choose ${option.label} and see its detail`
                              }
                            >
                              <span className="profile-figure">
                                <strong>{formatDistance(result.distanceM)}</strong>
                                {formatDuration(result.timeS)} · {Math.round(result.ascendM)} m
                              </span>
                              {/* The affordance has to match what the tap does, or the row
                                  reads as "go in" when it now means "undo". */}
                              {plan.chosen === option.id ? <ClearIcon /> : <ChevronRightIcon />}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </fieldset>

                  <Waypoints plan={plan} />

                  <div className="sheet-actions">
                    <button
                      type="button"
                      onClick={plan.clear}
                      disabled={plan.waypoints.length === 0}
                    >
                      Clear route
                    </button>
                  </div>
                </>
              )}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  )
}

function Waypoints({ plan }: { plan: Plan }) {
  if (plan.waypoints.length === 0) return null
  return (
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
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

/**
 * Hands the GPX to the OS.
 *
 * `navigator.share` with a File is the one that matters on iOS — it puts the route into
 * Files, Mail, or another cycling app in two taps. The download fallback covers desktop,
 * where sharing a file is often unsupported.
 */
async function exportGpx(gpx: string | null, profile: string | null): Promise<void> {
  if (!gpx || !profile) return
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
