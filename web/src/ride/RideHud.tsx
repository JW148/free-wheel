import { useEffect, useState } from 'react'
import type { GradientAhead } from './climbs'
import { formatAway, formatClock, formatElapsed, formatPower, formatSpeed } from './format'
import { formatDistance } from './gpx'
import { formatGrade, gradeColour } from './gradeScale'
import { calloutFor, compactFigures, figuresFor, hudPageAt, hudPages, type FigureKey } from './hud'
import { nextTurn, turnLabel, type Turn } from './turns'
import TurnGlyph from './TurnGlyph'
import type { RideTelemetry } from './useRideTelemetry'
import RideProfile, { RouteOverview } from './RideProfile'
import HoldButton from './HoldButton'
import { useHudDrag } from './useHudDrag'

/**
 * The riding screen's chrome: four figures, the road ahead, and one thing to do about it.
 *
 * ## What is on it, and what is not
 *
 * A rider glancing down has under a second and one hand. So the top row carries the figures
 * that change a decision — how fast, how hard, how far left, when you get there — and
 * everything else is either on the profile strip or not shown at all. Total distance ridden,
 * average speed and calories are all *interesting*, and all of them are questions asked
 * afterwards rather than on the road; they live on the summary instead.
 *
 * Power is here rather than on the summary alone because it is the only figure that answers
 * "should I ease off", and the answer stops being useful ten minutes later.
 *
 * ## The callout is one line and it is the point of the feature
 *
 * "Climb in 450 m · 62 m at 6%" is what the user asked for, and it has to be a sentence rather
 * than a gauge because the three numbers are only meaningful together: 62 m is nothing at 2%
 * and a lot at 12%, and neither matters if it starts in 20 km.
 *
 * ## Two sizes, and one surface between them
 *
 * The panel covers the top quarter of the screen, which is a lot of map at a junction, so it
 * folds down to a strip: the same figures minus power, the whole-route progress bar, and the
 * climb line *only when there is a climb to name* (see `hud.ts`).
 *
 * It is **dragged** between the two, the way the plan sheet at the other end of the screen is
 * — pull down for the graph, push up for the strip — because nothing inside it is interactive,
 * so the whole surface can be the target. That is the difference between a 2.4rem chevron a
 * rider has to aim at while moving and a gesture they can make with the heel of a hand.
 * `useHudDrag` writes `--hud-p`, 0 on the strip and 1 on the graph, and the height, both
 * layers' opacity and the chevron's rotation are `calc()`s over it, so a half-finished drag is
 * a half-finished fold rather than a state nothing can draw. The chevron stays, centred on the
 * bottom edge where a handle belongs: it is what *says* the panel moves, and it is still the
 * way in from a keyboard or VoiceOver.
 *
 * Height, not `max-height`, and measured in pixels by a `ResizeObserver` rather than guessed:
 * the strip's height is not constant — the climb line appears and disappears inside it — so a
 * fixed collapsed height would either clip the line or leave a gap where it is not. Animating
 * a `backdrop-filter`ed box's height is the thing `ride.css` warns about for the control rail,
 * and the warning holds: it is affordable here because it happens under a deliberate finger
 * rather than once a second, and because only the panel animates rather than a stack of seven
 * blurred buttons.
 */
export default function RideHud({
  telemetry,
  speedMps,
  fixLabel,
  offRouteHint,
  onReroute,
  rerouting,
  controls,
  onEnd,
  expanded,
  onExpandedChange,
  page,
  onPageChange,
}: {
  telemetry: RideTelemetry
  speedMps: number | null
  /** The fix's own status line — accuracy, or why there isn't one. */
  fixLabel: string
  /** How far off the line the rider is, for the off-route banner. */
  offRouteHint: string | null
  onReroute: () => void
  rerouting: boolean
  /**
   * The floating map buttons, passed in rather than rendered here.
   *
   * `.ride-chrome` is a flex column and `.map-controls` is the element that grows to fill it,
   * so the status bar only ends up at the bottom of the screen if the controls sit *between*
   * the two. That is a layout fact about the riding chrome, which is what this component is —
   * so it owns the order, and the buttons are a slot.
   */
  controls: React.ReactNode
  onEnd: () => void
  /** Whether the panel is open at all. Owned by `RideView`, which persists it. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /**
   * Which page the opened panel is on. Persisted like {@link expanded}, and for the same
   * reason: which of the two a rider wants is a preference, not a per-ride decision.
   */
  page: number
  onPageChange: (page: number) => void
}) {
  const { progress, geometry, climbs, record, ahead, rest, powerW, arrivalAt, offRoute } = telemetry
  // Off route, the next junction describes a road the rider has left. Drawing it there would
  // point at a turning that is not in front of them, which is worse than the blank the
  // off-route banner already puts on screen.
  const turnAhead = offRoute ? null : telemetry.turnAhead
  // The elapsed clock has to move on its own. Everything else on this panel is refreshed by a
  // fix arriving, but a rider stopped at a level crossing gets no fixes worth reporting and
  // the one number that must keep counting is the one that would stop.
  useTicker(record !== null)

  // Geometry alone, not geometry *and* a fix: the seconds between Start and the first fix are
  // a route being followed by a rider whose position is not known yet, and the honest way to
  // draw that is the route's own figures reading em dashes — not a different panel.
  const hasRoute = geometry !== null
  const hasElevation = geometry?.hasElevation ?? false
  const figures = figuresFor({ hasElevation })
  const mini = compactFigures(figures)
  const value = figureValues({ speedMps, powerW, progress, arrivalAt, record })

  /**
   * Whether the rider's place on the line is known yet.
   *
   * Everything drawn against the route — the lookahead, the progress bar, the callout — needs
   * a snapped position, and there is none until the first fix arrives. The figures are drawn
   * regardless: a dash where a number will be is a number waiting, and the status bar below
   * says what it is waiting for.
   */
  const tracking = hasRoute && progress !== null
  const strip = calloutFor(turnAhead?.awayM ?? null, ahead, hasElevation)

  /*
   * What the opened panel can show, and which of those the rider is on.
   *
   * `page` is remembered across launches, so it can name a page this ride does not have — a
   * rider who left it on navigation and then loaded a recorded track with no junctions. The
   * clamp is what stops that being a blank panel.
   */
  const turns = telemetry.turns
  const pages = hudPages({ hasElevation, hasTurns: turns.length > 0 })
  const shownPage = hudPageAt(pages, page)
  const nextAfter = turnAhead ? nextTurn(turns, turnAhead.turn.atM) : null

  const hud = useHudDrag({
    expanded,
    onExpandedChange,
    page: Math.max(0, pages.indexOf(shownPage ?? 'graph')),
    pages: pages.length,
    onPageChange,
  })

  return (
    <>
      <div
        className="hud panel"
        ref={hud.panel}
        // This and `data-dragging` are the hook's from here: it measures both layers and
        // publishes their heights, and until it has there is no honest height to fold through.
        data-measured="no"
        {...hud.drag}
      >
        <div
          className="hud-layer"
          data-layer="full"
          ref={hud.full}
          data-shown={expanded ? 'yes' : 'no'}
          aria-hidden={!expanded}
        >
          <Figures keys={figures} value={value} />

          {/*
           * The pages, side by side on a track that `--hud-x` slides.
           *
           * Both are always laid out, which is what keeps the panel's measured height steady
           * across a swipe: the layer is as tall as the taller page and nothing jumps when
           * one replaces the other. The cost is slack under the shorter one, which is cheap
           * next to a panel that changes height under a moving finger.
           */}
          <div className="hud-pages">
          <div className="hud-track">
            {pages.map((name) => (
              <div
                className="hud-page"
                key={name}
                // The page off screen is still laid out, so it has to be taken off the
                // accessibility tree by hand or a screen reader reads both.
                aria-hidden={name !== shownPage}
              >
                {name === 'graph' ? (
                  <>
                    {tracking && <RideProfile geometry={geometry} progress={progress} />}
                    {/* The turn keeps its line here as well as having a page of its own. The
                        page is the *large* version for a rider who asked for it; taking the
                        line away would mean anyone who stays on the graph loses the turn
                        entirely, which is a worse panel than the one before there were
                        pages. Above the climb, because it is the nearer of the two and the
                        one with a deadline. */}
                    {tracking && turnAhead && (
                      <TurnCallout turn={turnAhead.turn} awayM={turnAhead.awayM} />
                    )}
                    {tracking && (
                      <Callout ahead={ahead} rest={rest} grade={progress.grade} />
                    )}
                  </>
                ) : (
                  <NavPage turn={turnAhead} next={nextAfter} />
                )}
              </div>
            ))}
            </div>
          </div>

          {/* Under the pages, because progress along the line is true whichever one is up —
              and it is the one thing on the panel that never stops being relevant. */}
          {tracking && <RouteOverview geometry={geometry} progress={progress} climbs={climbs} />}

          {/* Kept unconditional on the turns, which it briefly was not. Without heights there
              is no graph page, and this line is the only thing that says why — a rider left
              with a single page and no explanation would read it as the app having lost one. */}
          {hasRoute && !hasElevation && (
            <p className="hud-callout">
              <span className="hud-callout-mark" style={{ '--tint': 'currentColor' } as React.CSSProperties} />
              No surveyed heights on this track, so no gradients or power.
            </p>
          )}

          {/* Two dots, because a swipe with no affordance is a swipe nobody makes. Quiet and
              not a control: the chevron owns this strip and a press here toggles the panel,
              which is what it did before there were pages. */}
          {pages.length > 1 && (
            <div className="hud-dots" aria-hidden="true">
              {pages.map((name) => (
                <span key={name} data-on={name === shownPage ? 'yes' : 'no'} />
              ))}
            </div>
          )}
        </div>

        <div
          className="hud-layer"
          data-layer="mini"
          ref={hud.mini}
          data-shown={expanded ? 'no' : 'yes'}
          aria-hidden={expanded}
        >
          <Figures keys={mini} value={value} compact />
          {tracking && <RouteOverview geometry={geometry} progress={progress} climbs={climbs} />}
          {/* One line, and `calloutFor` decides which. The strip's budget is one thing at a
              time, and text appearing on it is itself the signal. */}
          {tracking && strip === 'turn' && turnAhead && (
            <TurnCallout turn={turnAhead.turn} awayM={turnAhead.awayM} />
          )}
          {tracking && strip === 'climb' && (
            <Callout ahead={ahead} rest={null} grade={progress.grade} />
          )}
        </div>

        {/* The handle, and the only thing on the panel a press means something by. A tap
            toggles; a drag from it is a drag like any other, because it sits in the strip of
            room both layers leave along the bottom edge rather than over either of them. */}
        <button
          type="button"
          className="hud-collapse"
          onClick={hud.onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide the elevation graph' : 'Show the elevation graph'}
        >
          <ChevronIcon />
        </button>
      </div>

      {offRoute && (
        <div className="hud-alert panel" role="alert">
          <span>
            <strong>Off route</strong>
            {offRouteHint && ` · ${offRouteHint}`}
          </span>
          <button type="button" className="primary" onClick={onReroute} disabled={rerouting}>
            {rerouting ? 'Routing…' : 'Reroute'}
          </button>
        </div>
      )}

      {controls}

      {/*
        What the ride has come to, and the one way out of it.

        Two lines rather than one: the figures are the sentence and the fix is the footnote, and
        running them together meant "±5 m" sat in the middle of a distance and a climb. Ending
        is a hold — see `HoldButton` — because a tap is a gesture a pothole can make.
      */}
      <div className="ride-status" data-bottom-bar="">
        <span className="ride-status-text">
          {/* "As a user I wasn't clear exactly when I was in navigation mode." The bar is now
              ink-filled rather than a white panel, which is the difference a glance actually
              catches, and it says the word. The dot pulses because the alternative — a static
              badge — is indistinguishable from a label. */}
          <span className="ride-live" aria-hidden="true" />
          {record ? (
            <>
              <strong>Riding · {formatElapsed((Date.now() - record.startedAt) / 1000)}</strong>
              {` · ${(record.distanceM / 1000).toFixed(1)} km`}
              {record.ascentM > 5 && ` · ${Math.round(record.ascentM)} m up`}
              <span className="ride-status-fix">{fixLabel} · recording</span>
            </>
          ) : (
            <>
              <strong>Riding</strong>
              <span className="ride-status-fix">{fixLabel}</span>
            </>
          )}
        </span>
        <HoldButton onHold={onEnd} aria-label="Hold to end the ride">
          Hold to end
        </HoldButton>
      </div>
    </>
  )
}

/**
 * A figure's label, its value, and whether it is modelled rather than measured.
 *
 * A table rather than a switch in the markup, because the same five figures are drawn twice —
 * once expanded, once on the strip — and a duplicated ternary chain is how the two sizes end
 * up disagreeing about what "to go" means.
 */
function figureValues(input: {
  speedMps: number | null
  powerW: number | null
  progress: RideTelemetry['progress']
  arrivalAt: number | null
  record: RideTelemetry['record']
}): Record<FigureKey, { unit: string; text: string; estimate?: boolean }> {
  const { speedMps, powerW, progress, arrivalAt, record } = input
  return {
    speed: { unit: 'km/h', text: formatSpeed(speedMps) },
    power: { unit: 'watts', text: formatPower(powerW), estimate: true },
    togo: { unit: 'to go', text: progress ? formatAway(progress.remainingM) : '—' },
    arrive: { unit: 'arrive', text: formatClock(arrivalAt) },
    ridden: { unit: 'ridden', text: record ? formatDistance(record.distanceM) : '—' },
  }
}

function Figures({
  keys,
  value,
  compact,
}: {
  keys: FigureKey[]
  value: Record<FigureKey, { unit: string; text: string; estimate?: boolean }>
  compact?: boolean
}) {
  return (
    <dl
      className="hud-figures"
      data-compact={compact ? 'yes' : 'no'}
      style={{ '--columns': keys.length } as React.CSSProperties}
    >
      {keys.map((key) => (
        <Figure key={key} value={value[key].text} unit={value[key].unit} estimate={value[key].estimate} />
      ))}
    </dl>
  )
}

function Figure({
  value,
  unit,
  estimate,
}: {
  value: string
  unit: string
  /** Marks a figure the app is inferring rather than measuring. */
  estimate?: boolean
}) {
  return (
    <div>
      <dt>
        {unit}
        {/* A tilde, not the word "estimated": the label has room for four characters and the
            rider needs to know it is modelled, not read a disclaimer at 25 km/h. The full
            explanation is in the rider settings, where there is room for it. */}
        {estimate && <span className="hud-estimate" aria-label="estimated"> ~</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  )
}

/**
 * The next turn, at the size the panel actually has room for.
 *
 * The callout line is 32 px of arrow beside a sentence, which is right for a strip whose whole
 * budget is one line. Opened, the panel has the height of a chart to spend, and the first
 * report from looking at it was the obvious one: the arrow is too small to read at speed. So
 * this is the other half of the trade — the rider swipes to say "I am navigating", and gets an
 * arrow four times the area and a distance in the same type as the figures above it.
 *
 * **Never blank.** A turn is a point on a road and most of a ride is between two of them, so
 * with nothing inside the horizon this says how far the next one is, in the same shape. A
 * panel a rider swiped to and found empty is a panel they do not swipe to twice.
 */
function NavPage({
  turn,
  next,
}: {
  turn: { turn: Turn; awayM: number } | null
  /** The one after it, named small, so a junction pair can be seen coming rather than heard. */
  next: Turn | null
}) {
  if (!turn) {
    return (
      <div className="hud-nav" data-empty="yes">
        <p className="hud-nav-none">No turns ahead on this route.</p>
      </div>
    )
  }

  return (
    <div className="hud-nav">
      <TurnGlyph kind={turn.turn.kind} />
      <div className="hud-nav-text">
        <p className="hud-nav-distance">{formatAway(turn.awayM)}</p>
        <p className="hud-nav-label">{turnLabel(turn.turn)}</p>
        {next && (
          <p className="hud-nav-next">
            then {turnLabel(next).toLowerCase()} in {formatAway(next.atM - turn.turn.atM)}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * One line about the next thing the hands will do.
 *
 * Built from the same `.hud-callout` row as the climb, with the arrow standing in for the
 * tint bar — same height, same gap, so the two callouts are interchangeable in the strip's
 * single slot rather than two different-sized lines swapping places.
 *
 * Untinted, deliberately. The climb callout's bar carries the gradient colour because severity
 * is the thing it is reporting; a turn has no severity, and a colour here would be the second
 * palette on a panel that already reads by hue.
 */
function TurnCallout({ turn, awayM }: { turn: Turn; awayM: number }) {
  return (
    <p className="hud-callout hud-callout-turn">
      <TurnGlyph kind={turn.kind} />
      <strong>{turnLabel(turn)}</strong> in {formatAway(awayM)}
    </p>
  )
}

/**
 * One line about the next thing the legs will notice.
 *
 * Precedence, and it is the whole design: being *on* a climb beats a climb ahead, which beats
 * a descent ahead, which beats nothing. A rider halfway up a wall does not want to be told
 * about the descent after it — they want to know how much is left. Conversely on the flat the
 * descent is worth mentioning, because "there is a break coming" is information too.
 *
 * `rest` is passed as `null` by the collapsed strip, which is how the descent line is dropped
 * there without this function needing to know which size it is drawing for.
 */
function Callout({
  ahead,
  rest,
  grade,
}: {
  ahead: GradientAhead | null
  rest: GradientAhead | null
  grade: number
}) {
  if (ahead?.inIt) {
    const { gradient } = ahead
    return (
      <p className="hud-callout" style={{ '--tint': gradeColour(gradient.grade) } as React.CSSProperties}>
        <span className="hud-callout-mark" />
        <strong>Climbing</strong> {formatAway(ahead.remainingM)} left ·{' '}
        {Math.round(ahead.remainingGainM)} m up
        {` · ${formatGrade(grade)} now`}
      </p>
    )
  }

  if (ahead) {
    const { gradient } = ahead
    return (
      <p className="hud-callout" style={{ '--tint': gradeColour(gradient.grade) } as React.CSSProperties}>
        <span className="hud-callout-mark" />
        <strong>Climb in {formatAway(ahead.distanceToM)}</strong> · {Math.round(gradient.gainM)} m
        at {formatGrade(gradient.grade)}
        {/* Only where it differs enough to change the gear you pick. A "max 7%" next to an
            "avg 6%" is noise; a "max 14%" next to it is the whole story. */}
        {gradient.maxGrade > gradient.grade + 0.02 && `, up to ${formatGrade(gradient.maxGrade)}`}
      </p>
    )
  }

  if (rest) {
    return (
      <p className="hud-callout" style={{ '--tint': gradeColour(-0.05) } as React.CSSProperties}>
        <span className="hud-callout-mark" />
        {/* `inIt`, like the climb branch above. Without it a rider halfway down was told
            "Downhill in 0 m", which is both wrong and faintly insulting. */}
        {rest.inIt ? (
          <>
            <strong>Descending</strong> {formatAway(rest.remainingM)} left
          </>
        ) : (
          <>
            <strong>Downhill in {formatAway(rest.distanceToM)}</strong> ·{' '}
            {formatAway(rest.gradient.lengthM)} of it
          </>
        )}
      </p>
    )
  }

  return (
    <p className="hud-callout" style={{ '--tint': gradeColour(0) } as React.CSSProperties}>
      <span className="hud-callout-mark" />
      Nothing steep left on this route.
    </p>
  )
}

/** Re-renders once a second while `active`, purely so a running clock runs. */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

/** Points down to fold the panel away, up to bring it back. Rotated by CSS. */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  )
}
