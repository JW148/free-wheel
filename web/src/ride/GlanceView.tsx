import { useRef } from 'react'
import TurnGlyph from './TurnGlyph'
import type { RideTelemetry } from './useRideTelemetry'
import { formatAway, formatClock, formatSpeed } from './format'
import { formatGrade, gradeColour } from './gradeScale'
import { calloutMatters } from './hud'
import { turnLabel } from './turns'
import {
  AHEAD_M,
  glanceCue,
  glanceLine,
  rejoinAngle,
  svgPoints,
  travelBearing,
  type Point,
} from './glance'

/**
 * The glance view: the riding screen with the map taken away.
 *
 * Black, so the OLED panel has almost nothing to light; one polyline of the road ahead, redrawn
 * when a fix arrives and at no other time; and the one instruction that matters, dimmed until a
 * turn is close. Nothing on it animates — no transition, no pulse, no ticking clock — because a
 * CSS animation is a compositor frame and the point of the screen is to draw as few of those as
 * possible. The decisions are all in `glance.ts`; this only lays them out.
 *
 * The map is still mounted underneath and is hidden, not removed, so the button back to it is
 * instant. `RideView` stops writing to it while this is up, which is what keeps it from drawing:
 * MapLibre only renders when something asks it to.
 */

/** The drawing's own units. Width is the narrowest phone; the SVG scales to the screen. */
const VIEW_W = 360
const VIEW_H = 420
/** Where the rider sits: centred, and low, so most of the height is road ahead. */
const RIDER: Point = [VIEW_W / 2, VIEW_H - 92]
/** The scale on route: the window ahead fills the space above the rider. */
const PX_PER_M = (RIDER[1] - 12) / AHEAD_M
/** Off route the scale gives way so the rejoin point stays on screen, however far off it is. */
const REJOIN_MAX_PX = 150

export default function GlanceView({
  telemetry,
  fix,
  heading,
  speedMps,
  rerouting,
  onReroute,
  onShowMap,
  problem,
}: {
  telemetry: RideTelemetry
  fix: { lon: number; lat: number } | null
  /** The rider's own heading, for off route — where the route cannot say which way they face. */
  heading: number | null
  speedMps: number | null
  rerouting: boolean
  onReroute: () => void
  onShowMap: () => void
  problem: string | null
}) {
  const { geometry, progress, offRoute, turns, turnAhead, ahead, arrivalAt } = telemetry
  const tracking = geometry !== null && progress !== null && fix !== null

  // Off route there is no road to take a bearing from, and the rider's own heading is null
  // whenever they stop. Holding the last on-route bearing keeps the line still rather than
  // snapping it to north-up the moment they pull over to work out where they are.
  const lastBearing = useRef(0)
  let line = null
  let pxPerM = PX_PER_M
  if (tracking) {
    const alongM = progress.position.alongM
    const bearing = offRoute ? (heading ?? lastBearing.current) : travelBearing(geometry, alongM)
    lastBearing.current = bearing
    line = glanceLine({
      geometry,
      alongM,
      snapped: progress.position.point,
      fix: [fix.lon, fix.lat],
      offRoute,
      bearing,
      turn: offRoute ? null : (turnAhead?.turn ?? null),
    })
    if (line.rejoin) {
      const away = Math.hypot(line.rejoin[0], line.rejoin[1])
      if (away * pxPerM > REJOIN_MAX_PX) pxPerM = REJOIN_MAX_PX / away
    }
  }

  const cue = glanceCue({
    tracking,
    offRoute,
    offsetM: progress?.position.offsetM ?? null,
    turns,
    turnAhead,
    remainingM: progress?.remainingM ?? null,
    speedMps,
    label: turnLabel,
  })

  const distance = cue.distanceM === null ? null : splitUnit(formatAway(cue.distanceM))
  const togo = progress ? splitUnit(formatAway(progress.remainingM)) : null
  const climb =
    cue.tone !== 'off' && geometry && calloutMatters(ahead, geometry.hasElevation) ? ahead : null
  const turnAt = line?.turn

  return (
    <div className="glance" data-tone={cue.tone}>
      <div className="glance-cue" aria-live="polite">
        <span
          className="glance-glyph"
          style={
            cue.tone === 'off'
              ? { transform: `rotate(${rejoinAngle(line?.rejoin ?? null).toFixed(0)}deg)` }
              : undefined
          }
        >
          <TurnGlyph kind={cue.glyph} />
        </span>
        <div>
          <p className="glance-distance">
            {distance ? (
              <>
                {distance.value}
                <small>{distance.unit}</small>
              </>
            ) : (
              '—'
            )}
          </p>
          <p className="glance-words">{cue.words}</p>
        </div>
      </div>

      {cue.then && (
        <p className="glance-then">
          then <TurnGlyph kind={cue.then.kind} /> {turnLabel(cue.then).toLowerCase()} in{' '}
          {formatAway(cue.then.atM - (turnAhead?.turn.atM ?? 0))}
        </p>
      )}
      {cue.tone === 'off' && (
        <button type="button" className="glance-then glance-reroute" onClick={onReroute} disabled={rerouting}>
          {rerouting ? 'Finding a way back…' : 'Reroute from here'}
        </button>
      )}

      <svg
        className="glance-road"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {line && (
          <>
            {line.ridden.length > 1 && (
              <polyline className="glance-ridden" points={svgPoints(line.ridden, pxPerM, RIDER)} />
            )}
            {line.ahead.length > 1 && (
              <polyline className="glance-ahead" points={svgPoints(line.ahead, pxPerM, RIDER)} />
            )}
            {line.rejoin && (
              <polyline
                className="glance-rejoin"
                points={svgPoints([[0, 0], line.rejoin], pxPerM, RIDER)}
              />
            )}
            {turnAt && (
              <g
                className="glance-turn"
                transform={`translate(${(RIDER[0] + turnAt.at[0] * pxPerM).toFixed(1)} ${(
                  RIDER[1] -
                  turnAt.at[1] * pxPerM
                ).toFixed(1)})`}
              >
                {turnAt.turn.kind === 'roundabout' && turnAt.turn.exit !== null ? (
                  <>
                    <circle r="17" />
                    <text dy="0.36em">{turnAt.turn.exit}</text>
                  </>
                ) : (
                  <circle r="8" />
                )}
              </g>
            )}
          </>
        )}
        <path
          className="glance-rider"
          d={`M${RIDER[0]} ${RIDER[1] - 18} l16 38 l-16 -9 l-16 9 z`}
        />
      </svg>

      {problem && (
        <p className="glance-problem" role="alert">
          {problem}
        </p>
      )}

      {climb && (
        <p className="glance-callout">
          <i style={{ background: gradeColour(climb.gradient.grade) }} />
          {climb.inIt
            ? `Climbing · ${formatAway(climb.remainingM)} left · ${Math.round(climb.remainingGainM)} m up`
            : `Climb in ${formatAway(climb.distanceToM)} · ${formatAway(climb.gradient.lengthM)} at ${formatGrade(climb.gradient.grade)}`}
        </p>
      )}

      <button type="button" className="glance-map" onClick={onShowMap} aria-label="Show the map">
        <MapIcon />
      </button>

      <div className="glance-foot">
        <div className="glance-bar">
          <span style={{ width: `${((progress?.fraction ?? 0) * 100).toFixed(1)}%` }} />
        </div>
        <dl className="glance-figures">
          <div>
            <dt>km/h</dt>
            <dd>{formatSpeed(speedMps)}</dd>
          </div>
          <div>
            <dt>{togo ? `${togo.unit} to go` : 'to go'}</dt>
            <dd>{togo?.value ?? '—'}</dd>
          </div>
          <div>
            <dt>arrive</dt>
            <dd>{formatClock(arrivalAt)}</dd>
          </div>
        </dl>
        <p className="glance-credit">Route data © OpenStreetMap contributors</p>
      </div>
    </div>
  )
}

/** `"1.2 km"` → `{ value: "1.2", unit: "km" }`, so the unit can be drawn smaller. */
function splitUnit(text: string): { value: string; unit: string } {
  const space = text.lastIndexOf(' ')
  return space === -1
    ? { value: text, unit: '' }
    : { value: text.slice(0, space), unit: text.slice(space + 1) }
}

/** A folded map: the way back to the full riding view. */
function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6 9 4l6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />
    </svg>
  )
}
