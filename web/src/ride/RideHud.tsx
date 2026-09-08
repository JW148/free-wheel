import { useEffect, useState } from 'react'
import type { GradientAhead } from './climbs'
import { formatAway, formatClock, formatElapsed, formatPower, formatSpeed } from './format'
import { formatGrade, gradeColour } from './gradeScale'
import type { RideTelemetry } from './useRideTelemetry'
import RideProfile from './RideProfile'

/**
 * The riding screen's chrome: four figures, the road ahead, and one thing to do about it.
 *
 * ## What is on it, and what is not
 *
 * A rider glancing down has under a second and one hand. So the top row carries the four
 * figures that change a decision — how fast, how hard, how far left, when you get there — and
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
}) {
  const { progress, geometry, climbs, record, ahead, rest, powerW, arrivalAt, offRoute } = telemetry
  // The elapsed clock has to move on its own. Everything else on this panel is refreshed by a
  // fix arriving, but a rider stopped at a level crossing gets no fixes worth reporting and
  // the one number that must keep counting is the one that would stop.
  useTicker(record !== null)

  return (
    <>
      <div className="hud panel">
        <dl className="hud-figures">
          <Figure value={formatSpeed(speedMps)} unit="km/h" />
          <Figure value={formatPower(powerW)} unit="watts" estimate />
          <Figure value={progress ? formatAway(progress.remainingM) : '—'} unit="to go" />
          <Figure value={formatClock(arrivalAt)} unit="arrive" />
        </dl>

        {geometry && progress && (
          <RideProfile geometry={geometry} progress={progress} climbs={climbs} />
        )}

        <Callout ahead={ahead} rest={rest} grade={progress?.grade ?? null} />
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
 */
function Callout({
  ahead,
  rest,
  grade,
}: {
  ahead: GradientAhead | null
  rest: GradientAhead | null
  grade: number | null
}) {
  if (ahead?.inIt) {
    const { gradient } = ahead
    return (
      <p className="hud-callout" style={{ '--tint': gradeColour(gradient.grade) } as React.CSSProperties}>
        <span className="hud-callout-mark" />
        <strong>Climbing</strong> {formatAway(ahead.remainingM)} left ·{' '}
        {Math.round(ahead.remainingGainM)} m up
        {grade !== null && ` · ${formatGrade(grade)} now`}
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
        <strong>Downhill in {formatAway(rest.distanceToM)}</strong> ·{' '}
        {formatAway(rest.gradient.lengthM)} of it
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
