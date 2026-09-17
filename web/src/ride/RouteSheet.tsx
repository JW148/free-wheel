import { useState } from 'react'
import { DEFAULT_PROFILES, PROFILES, profileById } from './profiles'
import type { Plan } from './useRoute'
import { formatDistance, formatDuration, hasHeights } from './gpx'
import ElevationProfile from './ElevationProfile'
import RouteClimbs from './RouteClimbs'
import { putEntry, routeEntry } from './library'
import { gpxFilename, shareGpx } from './share'
import type { RouteSheetState } from './useRouteSheet'
import { useSheetDrag } from './useSheetDrag'

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
 * ## One surface, not two components that resemble one
 *
 * The card and the sheet used to be exactly that: a flex child of the chrome layer, and a
 * vaul drawer portalled to `<body>`, with the first fading out as the second slid up. Nothing
 * connected them. Opening was a button press rather than a pull, and the card did not become
 * the sheet so much as get out of its way.
 *
 * Now there is one element. `--sheet-p` runs from 0 at the card to 1 open, and every
 * difference between the two states is a `calc()` over it — the side and bottom insets that
 * make the card float, the corner radii, the height, the scrim, and which of the two content
 * layers is legible. A finger writes the number directly; `useSheetDrag` does the arithmetic
 * and `sheetDrag.ts` holds the part with a decision in it.
 *
 * vaul was the obvious thing to reach for and it cannot do this. Its snap points translate one
 * full-height box up and down, so the box always continues past the bottom of the screen: a
 * minimised stop can be a bar, never an inset card with a rounded bottom edge and a shadow
 * under it. The card is the half worth keeping, so it decided the mechanism. vaul still owns
 * the Layers sheet and the finish sheet, which are modal and have one stop each.
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
  const detail = sheet.view === 'detail' && chosen !== null && plan.chosen !== null
  /*
   * Opening goes through `openForPlan`, not through `setOpen`, so a pull lands on the view the
   * rider is owed: the detail of a route they have already chosen, or the comparison if the
   * choice is still to make. The handle is now one of the three ways in — the map's route
   * lines and the chosen card's Details row are the others — and all of them ask the same
   * question.
   */
  const surface = useSheetDrag({
    open: sheet.open,
    setOpen: (next) => (next ? sheet.openForPlan() : sheet.setOpen(false)),
  })

  return (
    <div className="sheet-layer" ref={surface.layer} data-open={sheet.open ? 'yes' : 'no'}>
      {/* Decorative, and deliberately not a button: this is not a modal dialog but a bar that
          is always on screen, so the scrim is a convenience rather than the way out. Escape
          and the handle are the ways out that a keyboard can reach. */}
      <div className="sheet-scrim" aria-hidden="true" onClick={surface.collapse} />

      <div className="plan-sheet">
        {/* The one control the sheet always has, in both states. It drags — and a press on it
            is left to the click, which is the one form a keyboard and VoiceOver both arrive
            in. The pointer path stands aside rather than toggling the sheet twice. */}
        <button
          type="button"
          className="sheet-handle"
          data-sheet-handle=""
          aria-label="Route options"
          aria-expanded={sheet.open}
          aria-controls="plan-sheet-full"
          onClick={surface.onClick}
          {...surface.drag}
        />

        {/*
          The card. `data-bottom-bar` is measured by the ride screen so the map credit sits
          clear of it, and the height it reports is this layer's own — which is why the layer
          is laid out at a constant width and the sheet's growing one never reaches it.
        */}
        <div
          className="sheet-peek"
          ref={surface.peek}
          data-bottom-bar=""
          inert={sheet.open}
          {...surface.drag}
        >
          {routed || plan.routing ? (
            <RoutedCard plan={plan} sheet={sheet} onStart={onStart} />
          ) : plan.waypoints.length > 0 ? (
            <PointsCard plan={plan} />
          ) : (
            <InviteCard onOpenSaved={onOpenSaved} onOpenSetup={onOpenSetup} />
          )}
        </div>

        <div className="sheet-full" id="plan-sheet-full" ref={surface.full} inert={!sheet.open}>
          {/* The scroller drags the sheet too, from its top. The handle alone was 60×24px on
              the one surface a rider uses without looking; see `pendingVerdict` for how a
              press here stays a tap when it turns out to be one. */}
          <div className="drawer-body" {...surface.bodyDrag}>
            {detail ? (
              <RouteDetail plan={plan} sheet={sheet} onSaved={onSaved} />
            ) : (
              <RouteChoice plan={plan} sheet={sheet} onStart={onStart} />
            )}
          </div>
          {/*
            Start ride is a sibling of the scroller, not the last thing inside it.

            It was a `position: sticky` child, and sticky cannot be pushed outside its
            containing block — which ends at the scroller's own bottom padding, the home
            indicator's clearance. So the button pinned itself `--safe-bottom` short of the
            bottom and the climb list scrolled through the strip underneath it, in full view.
            Out here the sheet's flex column places it, nothing scrolls behind it, and it needs
            no background of its own.
          */}
          {detail && (
            <div className="drawer-footer">
              <button type="button" className="primary" onClick={onStart}>
                Start ride
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
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
          <span>Search a place, or tap the map to drop your start.</span>
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
 * A point tapped on the map shows its **coordinates**, because there is no geocoder on this
 * phone and there is not going to be one — turning a position into a name is a network service
 * and the whole app is built on not needing one. Four decimal places is about 11 m, which is
 * enough to tell two taps apart and short enough to fit.
 *
 * A point chosen *by name* from the search shows that name, and that is not the same thing
 * going the other way: the rider was handed a list and picked a row off it, so the name is
 * something they told the app rather than something it inferred.
 */
function PointsCard({ plan }: { plan: Plan }) {
  const [start, ...rest] = plan.waypoints
  const finish = rest.length > 0 ? rest[rest.length - 1] : null

  return (
    <>
      <div className="plan-points">
        <span className="plan-point-badge">S</span>
        <span className="plan-point-label">{named(start)}</span>
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
          {finish ? named(finish) : 'Search, or tap the map, for your finish'}
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
        <h2 className="drawer-title">Choose a route</h2>
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
  const idle = plan.routing === null
  const waiting = !result && !computing

  /*
   * One tap, two meanings, and which one depends on whether there is a result yet.
   *
   * With a result, the card is a choice. Without one — a profile the distance guard deferred,
   * or one just revealed by "More riding styles" — it is an offer to compute itself. From the
   * rider's side those are the same thing: a route they can see the name of and not the figures
   * for. Disabled while anything else is routing, because the Worker serialises anyway and a
   * second request would only race `routing` against itself.
   */
  const act = () => {
    if (result) sheet.choose(id)
    else if (idle && plan.waypoints.length >= 2) void plan.run(id)
  }

  return (
    <div className="route-card" data-chosen={isChosen ? 'yes' : 'no'}>
      {/* A real button rather than a `div` with `role="button"`: the chosen card grows two more
          buttons inside it, and an interactive element inside an interactive element is a
          target a screen reader cannot describe and a keyboard cannot reach past. */}
      <button
        type="button"
        className="route-card-main"
        data-pending={waiting ? 'yes' : 'no'}
        disabled={waiting && !idle}
        onClick={act}
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
      </button>

      {/* Only on the chosen card. The way into the detail view — with the drag handle, one of
          the two — and it exists nowhere else because there is nothing else it could describe. */}
      {isChosen && (
        <button type="button" className="route-card-details" onClick={() => sheet.setView('detail')}>
          Details
          <ChevronRightIcon />
        </button>
      )}
      {isChosen && (
        <button type="button" className="primary route-card-start" onClick={onStart}>
          Start ride
        </button>
      )}
    </div>
  )
}

/** Everything about one route, and the four things you might do with it. */
function RouteDetail({
  plan,
  sheet,
  onSaved,
}: {
  plan: Plan
  sheet: RouteSheetState
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
        <h2 className="drawer-title">{style.plain}</h2>
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
    </>
  )
}

function coords(point: { lat: number; lon: number }): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`
}

/** The name the rider chose, or the coordinates for a point they put down with a finger. */
function named(point: { lat: number; lon: number; label?: string }): string {
  return point.label ?? coords(point)
}

/**
 * Every point the route runs through, named.
 *
 * A reroute adds one of its own — where the rider rejoined the line after a wrong turn — and it
 * is named for what it is rather than counted as a via. Counting it would renumber the points
 * the rider actually placed, which is the same argument the pins on the map make.
 */
function Waypoints({ plan }: { plan: Plan }) {
  if (plan.waypoints.length === 0) return null
  let placed = 0
  return (
    <ol className="waypoints">
      {plan.waypoints.map((waypoint, index) => {
        const last = index === plan.waypoints.length - 1
        const rejoin = waypoint.kind === 'reroute' && !last && index > 0
        const ordinal = rejoin ? placed : placed++
        return (
        <li key={waypoint.id}>
          <span className="waypoint-role">
            {rejoin ? 'Rejoined' : index === 0 ? 'Start' : last ? 'Finish' : `Via ${ordinal}`}
          </span>
          <span className="waypoint-coords">{named(waypoint)}</span>
          <button
            type="button"
            onClick={() => plan.removeWaypoint(waypoint.id)}
            aria-label={`Remove point ${index + 1}`}
          >
            Remove
          </button>
        </li>
        )
      })}
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
