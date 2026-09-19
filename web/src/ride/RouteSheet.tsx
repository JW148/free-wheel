import { Fragment, useMemo, useState } from 'react'
import { DEFAULT_PROFILES, PROFILES, profileById } from './profiles'
import { waypointRows } from './plan'
import type { Plan } from './useRoute'
import { formatDistance, formatDuration, hasHeights } from './gpx'
import { routeGeometry } from './progress'
import { wayRuns } from './ways'
import ElevationProfile from './ElevationProfile'
import RouteBreakdown from './RouteBreakdown'
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
 * The points placed so far, and a slot for the finish if there is not one yet.
 *
 * Every point, not only the two ends. It used to read the first and the last and draw those,
 * which was honest while a third point was decoration and became a lie the moment the line
 * started following one: a rider who had tapped four times saw a card describing two of them.
 * The state is reachable in its own right, too — a routing failure leaves the plan un-routed
 * with however many points are on it, and `explainRoutingFailure` suggests adding one more.
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
  const awaitingFinish = plan.waypoints.length < 2
  return (
    <>
      {/* The finish is a slot rather than a row until something is in it. One point is not a
          journey, and a card that stopped at the start would not say what is missing. */}
      <PointList plan={plan} awaitingFinish={awaitingFinish} />
      <PlanNote awaitingFinish={awaitingFinish} />
    </>
  )
}

/**
 * Every point in the plan, as rows: a badge, what it is called, and the × that removes it.
 *
 * The same component in the card and in the open sheet, which is the whole reason it exists.
 * The sheet used to draw its own — a `Start | coordinates | Remove` table under a 4.5rem label
 * column — so the two surfaces described one list in two vocabularies, and the heavier of them
 * was the one a rider shaping a route looked at most. A badge, a dotted run and an × is the
 * card's language and it reads at a glance; "Remove" in full is a word doing a symbol's job.
 */
function PointList({ plan, awaitingFinish }: { plan: Plan; awaitingFinish: boolean }) {
  if (plan.waypoints.length === 0) return null

  return (
    <div className="plan-points">
      {waypointRows(plan.waypoints).map((row, index) => (
        <Fragment key={row.id}>
          {index > 0 && <PointLink />}
          <span className="plan-point-badge" data-role={row.role}>
            {row.badge}
          </span>
          <span className="plan-point-label">{named(plan.waypoints[index])}</span>
          <button
            type="button"
            className="plan-point-remove"
            onClick={() => plan.removeWaypoint(row.id)}
            aria-label={`Remove ${row.word.toLowerCase()}`}
          >
            ×
          </button>
        </Fragment>
      ))}

      {awaitingFinish && (
        <>
          <PointLink />
          <span className="plan-point-badge" data-placed="no">
            F
          </span>
          <span className="plan-point-label" data-placed="no">
            Search, or tap the map, for your finish
          </span>
          {/* The third column still has to be occupied, or the next row's badge flows into it
              and the whole grid steps sideways. */}
          <span />
        </>
      )}
    </div>
  )
}

/** The dotted run between two badges, plus the two cells it has to skip past. */
function PointLink() {
  return (
    <>
      <span className="plan-point-link" aria-hidden="true" />
      <span />
      <span />
    </>
  )
}

/**
 * How the gesture that edits a plan works, in one sentence.
 *
 * This is the whole of the discovery mechanism for stops, which is why it leads with the tap
 * rather than the drag: there is no Add-a-stop button on the map and deliberately no via mode,
 * so if this sentence does not say it, nothing does. It replaced "add more stops after your
 * finish", which described the old limitation — a tapped point could only ever land at the end
 * — as though it were a feature.
 *
 * Two sentences rather than one, because this card is on screen for a *moment*: the second
 * point routes the plan and the routed card replaces it. So the version a rider actually reads
 * is nearly always the one with a start and no finish — which is exactly the state in which
 * "add a stop along the way" is not yet true, there being no way to be along. It has to teach
 * the gesture without promising it works yet, and then say it plainly once it does.
 */
function PlanNote({ awaitingFinish }: { awaitingFinish: boolean }) {
  return (
    <p className="plan-note">
      {awaitingFinish
        ? 'Tap the map for your finish — then tap again to add stops along the way'
        : 'Tap the map to add a stop along the way · long-press a pin to drag it'}
    </p>
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
 *
 * ## Once there is a stop, there is one route
 *
 * You cannot shape a comparison. Three cards are three answers to "which way between these two
 * ends", and a stop changes the question — so all three are void, and re-running them on every
 * tap would put three blocking searches between the rider and the line they are drawing. The
 * engine-side half of that rule is in `profilesToRun`; this is the half the rider sees, and it
 * is why the heading stops asking them to choose.
 *
 * `plan.selection` is deliberately left alone through all of it. It is what the rider is
 * *offered*, not what is on the map, so taking the stops back out puts the comparison back
 * rather than leaving them with the one style they happened to be shaping in.
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
  const routed = Object.keys(plan.routes)
  const shown = more
    ? PROFILES
    : PROFILES.filter((p) => (plan.shaping ? routed.includes(p.id) : plan.selection.includes(p.id)))
  const canRoute = plan.waypoints.length >= 2 && plan.routing === null

  return (
    <>
      <div className="drawer-head">
        <h2 className="drawer-title">{plan.shaping ? 'Your route' : 'Choose a route'}</h2>
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

      {/* The plan's own points, one tap from the map rather than two. They describe the
          journey rather than any one route, so they belong here beside the actions that act on
          the journey — not in the detail view, which is about the one route it is showing.

          No `PlanNote` under it. The card carries that sentence, which is where a rider meets
          it while placing their first two points; repeating it here would say the same thing
          twice on one screen and push the actions down to make room. */}
      <PointList plan={plan} awaitingFinish={false} />

      <div className="sheet-actions">
        <button type="button" onClick={plan.reverse} disabled={plan.waypoints.length < 2}>
          Reverse
        </button>
        {/*
          The one shape a tap cannot make, because nobody can tap exactly on their own front
          door — so it is the only part of stops that needs a button at all, and it sits with
          the two other things that act on the whole plan rather than on a point.
        */}
        <button type="button" onClick={plan.makeLoop} disabled={!plan.canLoop}>
          Make a loop
        </button>
        <button type="button" onClick={plan.clear} disabled={plan.waypoints.length === 0}>
          Clear
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

  // Null for a recorded ride and for anything saved before the app started asking BRouter for
  // tags. Both flow through as "nothing to draw" rather than as an empty strip.
  const runs = useMemo(() => {
    const geometry = routeGeometry(chosen)
    return geometry ? wayRuns(chosen, geometry) : null
  }, [chosen])

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
          <ElevationProfile
            route={chosen}
            colour={style.colour}
            label={style.plain}
            runs={runs}
          />
          <RouteClimbs route={chosen} />
        </>
      ) : (
        <p className="warn">
          This track carries no surveyed heights, so there is no elevation profile and no climb
          list. Distance is measured from the track itself.
        </p>
      )}

      {/* Outside the heights branch, on purpose. Surfaces and road classes come off BRouter's
          tags rather than off SRTM, so a route whose heights are missing can still say what it
          is made of. A recorded ride has neither and shows neither. */}
      <RouteBreakdown route={chosen} />

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
