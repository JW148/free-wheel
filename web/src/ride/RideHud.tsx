import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GradientAhead } from './climbs'
import { formatAway, formatClock, formatElapsed, formatPower, formatSpeed } from './format'
import { formatDistance } from './gpx'
import { formatGrade, gradeColour } from './gradeScale'
import { calloutMatters, compactFigures, figuresFor, type FigureKey } from './hud'
import type { RideTelemetry } from './useRideTelemetry'
import RideProfile, { RouteOverview } from './RideProfile'

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
 * ## Two sizes, and why the transition is a measured height
 *
 * The panel covers the top quarter of the screen, which is a lot of map at a junction, so it
 * folds down to a strip: the same figures minus power, the whole-route progress bar, and the
 * climb line *only when there is a climb to name* (see `hud.ts`). Expanding and collapsing is
 * a plain `height` transition on the panel with the two contents cross-fading inside it,
 * absolutely positioned so neither reflows during the animation.
 *
 * Height, not `max-height`, and measured in pixels by a `ResizeObserver` rather than guessed:
 * the strip's height is not constant — the climb line appears and disappears inside it — so a
 * fixed collapsed height would either clip the line or leave a gap where it is not. Animating
 * a `backdrop-filter`ed box's height is the thing `ride.css` warns about for the control rail,
 * and the warning holds: it is affordable here because it happens on a deliberate tap rather
 * than once a second, and because only the panel animates rather than a stack of seven
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
  /** Whether the panel is showing the graph. Owned by `RideView`, which persists it. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const { progress, geometry, climbs, record, ahead, rest, powerW, arrivalAt, offRoute } = telemetry
  // The elapsed clock has to move on its own. Everything else on this panel is refreshed by a
  // fix arriving, but a rider stopped at a level crossing gets no fixes worth reporting and
  // the one number that must keep counting is the one that would stop.
  useTicker(record !== null)

  const following = geometry !== null && progress !== null
  const hasElevation = geometry?.hasElevation ?? false
  const figures = figuresFor({ hasRoute: following, hasElevation })
  const mini = compactFigures(figures)
  const value = figureValues({ speedMps, powerW, progress, arrivalAt, record })

  /**
   * Whether the full panel is on screen.
   *
   * Not simply the preference: with no route there is nothing to fold away — both sizes carry
   * the same three figures — and the one thing only the full layer has is the line explaining
   * that this is a recording with no route. A rider who collapsed the panel on their last
   * ride would otherwise start a free ride with the explanation hidden and no chevron to
   * reach it, because the chevron is not drawn when there is nothing to collapse.
   */
  const open = expanded || !following
  const shown = open ? 'full' : 'mini'
  const full = useMeasuredHeight()
  const strip = useMeasuredHeight()
  const height = (open ? full.height : strip.height) ?? undefined

  return (
    <>
      <div
        className="hud panel"
        data-mode={shown}
        // Until both layers have been measured there is no honest height to animate to, and
        // transitioning from the CSS fallback to the first measurement would animate on
        // arrival. `no` disables the transition for exactly that first frame.
        data-measured={full.height !== null && strip.height !== null ? 'yes' : 'no'}
        style={{ height }}
      >
        <div className="hud-layer" ref={full.ref} data-shown={open ? 'yes' : 'no'} aria-hidden={!open}>
          <Figures keys={figures} value={value} />

          {/* The lookahead is a chart of heights, so a track without any renders as a flat
              band — which is not "no data", it is a claim that the road ahead is level. The
              overview bar survives, because progress along the line is still true. */}
          {following && hasElevation && <RideProfile geometry={geometry} progress={progress} />}
          {following && <RouteOverview geometry={geometry} progress={progress} climbs={climbs} />}

          {/* Only where there is a route to say something about. Riding with no route is a
              legitimate state — recording your own line — and "nothing steep left on this
              route" would be a claim about a route that does not exist. */}
          {following && hasElevation && (
            <Callout ahead={ahead} rest={rest} grade={progress.grade} />
          )}
          {following && !hasElevation && (
            <p className="hud-callout">
              <span className="hud-callout-mark" style={{ '--tint': 'currentColor' } as React.CSSProperties} />
              No surveyed heights on this track, so no gradients or power.
            </p>
          )}
          {!following && (
            <p className="hud-callout">
              <span className="hud-callout-mark" style={{ '--tint': 'currentColor' } as React.CSSProperties} />
              Recording your own line. No route to follow.
            </p>
          )}
        </div>

        <div className="hud-layer" ref={strip.ref} data-shown={open ? 'no' : 'yes'} aria-hidden={open}>
          <Figures keys={mini} value={value} compact />
          {following && <RouteOverview geometry={geometry} progress={progress} climbs={climbs} />}
          {following && calloutMatters(ahead, hasElevation) && (
            <Callout ahead={ahead} rest={null} grade={progress.grade} />
          )}
        </div>

        {/* Nothing to fold away with no route: the strip and the panel would be the same
            three figures, and a button that does nothing visible is worse than no button. */}
        {following && (
          <button
            type="button"
            className="hud-collapse"
            onClick={() => onExpandedChange(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide the elevation graph' : 'Show the elevation graph'}
          >
            <ChevronIcon />
          </button>
        )}
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

      <div className="ride-status panel">
        <span className="ride-status-text">
          {record && (
            <>
              <strong>{formatElapsed((Date.now() - record.startedAt) / 1000)}</strong>
              {` · ${(record.distanceM / 1000).toFixed(1)} km`}
              {record.ascentM > 5 && ` · ${Math.round(record.ascentM)} m up`}
              {' · '}
            </>
          )}
          {fixLabel}
        </span>
        <button type="button" className="ghost" onClick={onEnd}>
          End ride
        </button>
      </div>
    </>
  )
}

/**
 * A figure's label, its value, and whether it is modelled rather than measured.
 *
 * A table rather than a switch in the markup, because the same six figures are drawn twice —
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
    elapsed: {
      unit: 'elapsed',
      text: record ? formatElapsed((Date.now() - record.startedAt) / 1000) : '—',
    },
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
      <dd>{value}</dd>
      <dt>
        {unit}
        {/* A tilde, not the word "estimated": the label has room for four characters and the
            rider needs to know it is modelled, not read a disclaimer at 25 km/h. The full
            explanation is in the rider settings, where there is room for it. */}
        {estimate && <span className="hud-estimate" aria-label="estimated"> ~</span>}
      </dt>
    </div>
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

/**
 * The rendered height of an element, tracked as it changes.
 *
 * A `ResizeObserver` rather than one `getBoundingClientRect` on mount, because both layers of
 * the HUD change height while the ride runs: the callout line grows to two lines on a narrow
 * phone, and on the strip it appears and vanishes with the climb. A stale measurement is a
 * clipped sentence.
 *
 * `useLayoutEffect` for the first read so the panel is laid out before the browser paints it,
 * which is what keeps the collapse transition from running once on arrival.
 */
function useMeasuredHeight() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setHeight(element.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, height }
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
