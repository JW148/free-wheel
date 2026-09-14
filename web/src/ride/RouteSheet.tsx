import { useState } from 'react'
import { Drawer } from 'vaul'
import { DEFAULT_PROFILES, PROFILES, profileById } from './profiles'
import type { Plan } from './useRoute'
import { formatDistance, formatDuration, hasHeights } from './gpx'
import ElevationProfile from './ElevationProfile'
import RouteClimbs from './RouteClimbs'
import { putEntry, routeEntry } from './library'
import { gpxFilename, shareGpx } from './share'
import type { RouteSheetState } from './useRouteSheet'

/**
 * The plan card, and the sheet it opens into.
 *
 * ## The card has three things to say, and only ever one of them
 *
 * *Nothing placed* — an invitation and two quiet shortcuts. *One point placed* — the start,
 * named, and a slot where the finish goes. *Routed* — what was chosen and the button that
 * rides it. They share the handle, the inset and the shadow, so it reads as one object
 * changing its mind rather than three panels swapping places.
 *
 * ## Choosing is three cards, not six tick-boxes
 *
 * The old flow asked the rider to tick routing profiles and press Compare — a question about
 * the software, asked *before* any route existed, whose answer they had no way to evaluate.
 * Now the second tap computes three and the choice is made by looking at them: Relaxed, Fast,
 * Off-road, with their figures. The other three profiles are one tap away under *More riding
 * styles*; nothing was removed.
 *
 * `plan.chosen` is still `null` until a card is tapped, and that is still the point. Anything
 * reading "the route" has to handle `null` rather than fall back to a default — the fallback
 * *was* the bug.
 *
 * ## Why vaul rather than a `max-height` transition
 *
 * Drag-to-dismiss done properly is velocity tracking, rubber-banding at the limits,
 * scroll/drag disambiguation inside the content, focus trapping and inert background — all of
 * which vaul already does correctly and none of which is interesting to rewrite. It portals to
 * `document.body`, so it is not subject to the chrome layer's flexbox at all, which is what
 * makes the overflow the old flex-child version suffered impossible rather than merely fixed.
 */

export default function RouteSheet({
  plan,
  sheet,
  onStart,
  onOpenSaved,
  onOpenSetup,
  onSaved,
}: {
  plan: Plan
  sheet: RouteSheetState
  onStart: () => void
  onOpenSaved: () => void
  onOpenSetup: () => void
  /** A route was saved to the library, so the Saved screen's list is stale. */
  onSaved: () => void
}) {
  const routeIds = Object.keys(plan.routes)
  const routed = routeIds.length > 0
  const chosen = plan.route

  return (
    <>
      {/*
        The card steps aside while the sheet is up.
        They are the two states of one surface, so both at once is a contradiction — and the
        sheet is only 94% opaque, so the card behind it bleeds through as a ghost of itself
        under the sheet's own buttons.
      */}
      <div className="sheet-bar panel" data-hidden={sheet.open ? 'yes' : 'no'}>
        <button
          type="button"
          className="card-handle"
          onClick={sheet.openForPlan}
          aria-label="Route options"
        />

        {routed || plan.routing ? (
          <RoutedCard plan={plan} sheet={sheet} onStart={onStart} />
        ) : plan.waypoints.length > 0 ? (
          <PointsCard plan={plan} />
        ) : (
          <InviteCard onOpenSaved={onOpenSaved} onOpenSetup={onOpenSetup} />
        )}
      </div>

      <Drawer.Root open={sheet.open} onOpenChange={sheet.setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="drawer-overlay" />
          <Drawer.Content className="drawer" aria-describedby={undefined}>
            <Drawer.Handle className="drawer-handle" />
            <div className="drawer-body">
              {sheet.view === 'detail' && chosen && plan.chosen ? (
                <RouteDetail plan={plan} sheet={sheet} onStart={onStart} onSaved={onSaved} />
              ) : (
                <RouteChoice plan={plan} sheet={sheet} onStart={onStart} />
              )}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  )
}

/** Nothing placed yet. The one sentence about what to do, and the two places worth going. */
function InviteCard({
  onOpenSaved,
  onOpenSetup,
}: {
  onOpenSaved: () => void
  onOpenSetup: () => void
}) {
  return (
    <>
      <div className="plan-invite">
        <span className="plan-invite-icon" aria-hidden="true">
          <PinIcon />
        </span>
        <span className="plan-invite-text">
          <strong>Plan a ride</strong>
          <span>Start, then finish. We do the rest.</span>
        </span>
      </div>
      <div className="plan-shortcuts">
        <button type="button" onClick={onOpenSaved}>
          <BookmarkIcon />
          Saved
        </button>
        <button type="button" onClick={onOpenSetup}>
          <SettingsIcon />
          Setup
        </button>
      </div>
    </>
  )
}

/**
 * A start placed and a finish still to come.
 *
 * The coordinates are shown rather than a place name, because there is no geocoder on this
 * phone and there is not going to be one — reverse geocoding is a network service, and the
 * whole app is built on not needing one. Four decimal places is about 11 m, which is enough to
 * tell two taps apart and short enough to fit.
 */
function PointsCard({ plan }: { plan: Plan }) {
  const [start, ...rest] = plan.waypoints
  const finish = rest.length > 0 ? rest[rest.length - 1] : null

  return (
    <>
      <div className="plan-points">
        <span className="plan-point-badge">S</span>
        <span className="plan-point-label">{coords(start)}</span>
        <button
          type="button"
          className="plan-point-remove"
          onClick={() => plan.removeWaypoint(start.id)}
          aria-label="Remove the start"
        >
          ×
        </button>

        <span className="plan-point-link" aria-hidden="true" />
        <span />
        <span />

        <span className="plan-point-badge" data-placed={finish ? 'yes' : 'no'}>
          F
        </span>
        <span className="plan-point-label" data-placed={finish ? 'yes' : 'no'}>
          {finish ? coords(finish) : 'Tap the map for your finish'}
        </span>
        {finish && (
          <button
            type="button"
            className="plan-point-remove"
            onClick={() => plan.removeWaypoint(finish.id)}
            aria-label="Remove the finish"
          >
            ×
          </button>
        )}
      </div>
      <p className="plan-note">Long-press a pin to drag it · add more stops after your finish</p>
    </>
  )
}

/** Routes exist, or are on their way. What was chosen, and the button that rides it. */
function RoutedCard({
  plan,
  sheet,
  onStart,
}: {
  plan: Plan
  sheet: RouteSheetState
  onStart: () => void
}) {
  const chosen = plan.route
  const style = plan.chosen ? profileById(plan.chosen) : null

  if (plan.routing) {
    return (
      <div className="action-row">
        <span className="plan-invite-text">
          <strong>Finding routes…</strong>
          <span>{profileById(plan.routing).plain}</span>
        </span>
        <button type="button" className="primary busy" onClick={plan.cancel}>
          Stop
        </button>
      </div>
    )
  }

  if (!chosen || !style) {
    // Routes on the map, none picked. The action is the decision, not the ride.
    return (
      <button type="button" className="primary" onClick={sheet.showCompare}>
        Choose a route
      </button>
    )
  }

  return (
    <>
      <div className="plan-invite">
        <span className="route-card-colour" style={{ background: style.colour, height: 34 }} />
        <span className="plan-invite-text">
          <strong>{style.plain}</strong>
          <span>
            {formatDistance(chosen.distanceM)}
            {chosen.timeS !== null && ` · ${formatDuration(chosen.timeS)}`}
            {` · ${Math.round(chosen.ascendM)} m up`}
          </span>
        </span>
      </div>
      <div className="action-row">
        <button type="button" className="primary" onClick={onStart}>
          Start ride
        </button>
      </div>
    </>
  )
}

/**
 * The three routes, and the way to the other three.
 *
 * The cards are ordered by the selection, not by the results, so a card holds its place while
 * the one above it is still computing — a list that reorders itself as results land is a list
 * you cannot tap.
 */
function RouteChoice({
  plan,
  sheet,
  onStart,
}: {
  plan: Plan
  sheet: RouteSheetState
  onStart: () => void
}) {
  const [more, setMore] = useState(false)
  const extra = PROFILES.filter((p) => !DEFAULT_PROFILES.includes(p.id))
  const shown = more ? PROFILES : PROFILES.filter((p) => plan.selection.includes(p.id))
  const canRoute = plan.waypoints.length >= 2 && plan.routing === null

  return (
    <>
      <div className="drawer-head">
        <Drawer.Title className="drawer-title">Choose a route</Drawer.Title>
        {plan.routing ? (
          <button type="button" className="primary busy" onClick={plan.cancel}>
            Stop
          </button>
        ) : (
          Object.keys(plan.routes).length === 0 && (
            <button
              type="button"
              className="primary"
              disabled={!canRoute}
              onClick={() => void plan.run()}
            >
              Find routes
            </button>
          )
        )}
      </div>

      {plan.warning && <p className="warn">{plan.warning}</p>}

      {plan.deferred.length > 0 && (
        <p className="warn">
          That is a long way, so only your usual style was worked out. The others will compute
          when you tap them.
        </p>
      )}

      <div className="route-cards">
        {shown.map((option) => (
          <RouteCard
            key={option.id}
            plan={plan}
            sheet={sheet}
            id={option.id}
            onStart={onStart}
          />
        ))}
      </div>

      {extra.length > 0 && (
        <button
          type="button"
          className="route-more"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? 'Fewer riding styles' : 'More riding styles'}
          <ChevronDownIcon />
        </button>
      )}

      <div className="sheet-actions">
        <button type="button" onClick={plan.reverse} disabled={plan.waypoints.length < 2}>
          Reverse
        </button>
        <button type="button" onClick={plan.clear} disabled={plan.waypoints.length === 0}>
          Clear route
        </button>
      </div>
    </>
  )
}

/**
 * One route, as a card.
 *
 * Four states, and each one has to be legible at a glance because three of them are on screen
 * at once: computed, computing, deferred (too long to have been worked out unasked), and not
 * offered at all — a profile revealed by *More riding styles* that has never been run.
 */
function RouteCard({
  plan,
  sheet,
  id,
  onStart,
}: {
  plan: Plan
  sheet: RouteSheetState
  id: string
  onStart: () => void
}) {
  const option = profileById(id)
  const result = plan.routes[id]
  const isChosen = plan.chosen === id
  const computing = plan.routing === id
  const waiting = !result && !computing

  return (
    <div
      className="route-card"
      data-chosen={isChosen ? 'yes' : 'no'}
      data-pending={waiting ? 'yes' : 'no'}
      onClick={() => {
        if (result) sheet.choose(id)
        // No result and nothing running: this card is an offer to compute itself. That covers
        // both a deferred profile and one just revealed by "More riding styles" — from the
        // rider's side they are the same thing, a route they can see the name of and not the
        // figures for.
        else if (!computing && plan.waypoints.length >= 2) void plan.run(id)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (result) sheet.choose(id)
        }
      }}
    >
      <span className="route-card-colour" style={{ background: option.colour }} />
      <span className="route-card-text">
        <span className="route-card-label">{option.plain}</span>
        <span className="route-card-note">{option.note}</span>
      </span>
      <span className="route-card-figures">
        {result ? (
          <>
            <strong>{result.timeS !== null ? formatDuration(result.timeS) : '—'}</strong>
            <span>
              {formatDistance(result.distanceM)} · {Math.round(result.ascendM)} m up
            </span>
          </>
        ) : (
          <span>{computing ? 'working…' : 'tap to work out'}</span>
        )}
      </span>

      {/* Only on the chosen card. The way into the detail view — with the drag handle, one of
          the two — and it exists nowhere else because there is nothing else it could describe. */}
      {isChosen && (
        <button
          type="button"
          className="route-card-details"
          onClick={(e) => {
            e.stopPropagation()
            sheet.setView('detail')
          }}
        >
          Details
          <ChevronRightIcon />
        </button>
      )}
      {isChosen && (
        <div className="action-row" style={{ gridColumn: '1 / -1' }}>
          <button type="button" className="primary" onClick={(e) => {
            e.stopPropagation()
            onStart()
          }}>
            Start ride
          </button>
        </div>
      )}
    </div>
  )
}

/** Everything about one route, and the four things you might do with it. */
function RouteDetail({
  plan,
  sheet,
  onStart,
  onSaved,
}: {
  plan: Plan
  sheet: RouteSheetState
  onStart: () => void
  onSaved: () => void
}) {
  const chosen = plan.route!
  const style = profileById(plan.chosen!)
  const [saved, setSaved] = useState<'idle' | 'saved' | 'failed'>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  const save = async () => {
    if (!plan.chosenGpx || !plan.chosen) return
    try {
      await putEntry(
        routeEntry({
          name: '',
          waypoints: plan.waypoints,
          profile: plan.chosen,
          gpx: plan.chosenGpx,
          route: chosen,
        }),
      )
      setSaved('saved')
      onSaved()
    } catch (e) {
      setSaved('failed')
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="drawer-head">
        <button
          type="button"
          className="drawer-back"
          onClick={() => sheet.setView('compare')}
          aria-label="Back to the routes"
        >
          <ChevronLeftIcon />
          Routes
        </button>
      </div>

      <div className="detail-title">
        <span className="swatch" style={{ background: style.colour }} />
        <Drawer.Title className="drawer-title">{style.plain}</Drawer.Title>
        {/* The engine's own name for it. Not on the cards — at the moment of choosing,
            "Trekking" is the word the rename was for — but here it is the useful fact, and
            this is the only place a rider can meet it. */}
        <span className="profile-pill">{style.label} profile</span>
      </div>
      <p className="plan-note">{style.note}</p>

      <dl className="detail-stats">
        <div>
          <dt>distance</dt>
          <dd>{formatDistance(chosen.distanceM)}</dd>
        </div>
        <div>
          <dt>moving</dt>
          <dd>{formatDuration(chosen.timeS)}</dd>
        </div>
        <div>
          <dt>climbing</dt>
          <dd>{Math.round(chosen.ascendM)} m</dd>
        </div>
      </dl>

      {/* A recorded track's heights came from whatever route it was ridden along, so a ride
          recorded without one has none at all — and an elevation chart drawn from zeros is a
          flat road, which is a claim about the terrain rather than an absence of one. */}
      {hasHeights(chosen) ? (
        <>
          <ElevationProfile route={chosen} colour={style.colour} label={style.plain} />
          <RouteClimbs route={chosen} />
        </>
      ) : (
        <p className="warn">
          This track carries no surveyed heights, so there is no elevation profile and no climb
          list. Distance is measured from the track itself.
        </p>
      )}

      <div className="route-actions">
        <button type="button" onClick={() => void save()} disabled={saved === 'saved'}>
          <BookmarkIcon />
          {saved === 'saved' ? 'Saved' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() =>
            plan.chosenGpx && plan.chosen && void shareGpx(plan.chosenGpx, gpxFilename(plan.chosen))
          }
          disabled={!plan.chosenGpx}
        >
          <ExportIcon />
          Export
        </button>
        {/* Turning round drops the computed route, because the way back is a different road —
            one-way streets and turn restrictions are not symmetric. */}
        <button type="button" onClick={plan.reverse}>
          <ReverseIcon />
          Reverse
        </button>
        <button type="button" onClick={plan.clear}>
          <ClearIcon />
          Clear
        </button>
      </div>

      {problem && (
        <p className="warn" role="alert">
          Could not save it: {problem}
        </p>
      )}

      <Waypoints plan={plan} />

      <div className="drawer-footer">
        <button type="button" className="primary" onClick={onStart}>
          Start ride
        </button>
      </div>
    </>
  )
}

function coords(point: { lat: number; lon: number }): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`
}

function Waypoints({ plan }: { plan: Plan }) {
  if (plan.waypoints.length === 0) return null
  return (
    <ol className="waypoints">
      {plan.waypoints.map((waypoint, index) => (
        <li key={waypoint.id}>
          <span className="waypoint-role">
            {index === 0 ? 'Start' : index === plan.waypoints.length - 1 ? 'Finish' : `Via ${index}`}
          </span>
          <span className="waypoint-coords">{coords(waypoint)}</span>
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

/* Inline SVG rather than sprite lookups: a missing sprite entry would be one more thing that
   can fail silently offline. */

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s6.5-6.1 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 14.9 12 21 12 21z" />
      <circle cx="12" cy="10.4" r="2.4" />
    </svg>
  )
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.4L5.5 21V4a1 1 0 0 1 1-1z" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h6M14 7h6M4 17h10M18 17h2" />
      <circle cx="12" cy="7" r="2.2" />
      <circle cx="16" cy="17" r="2.2" />
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V4M8 8l4-4 4 4M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  )
}

function ReverseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h11l-3-3M17 17H6l3 3" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
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

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
