import { pointAt, routeBearingAhead, bearingBetween, sliceAlong, type RouteGeometry } from './progress'
import { CHAIN_WITHIN_M, isActionable, type Turn, type TurnKind } from './turns'

/**
 * The glance view: the road ahead as one line, and the one instruction that matters.
 *
 * ## Why it exists
 *
 * The riding map is the most expensive thing the app draws. Every frame is a full-screen WebGL
 * render of a vector basemap, and on a phone held awake for a whole ride that is most of the
 * battery the app spends beyond the screen itself. The glance view is the other answer to the
 * same question: no basemap, a black screen — whose pixels an OLED panel switches off — and a
 * few hundred metres of route drawn as an SVG polyline once per fix. It is borrowed from the
 * Beeline Velo, whose whole display is this line.
 *
 * It is a view of the same ride, not a second mode with rules of its own: the turns, the
 * off-route judgement, the reroute and the speech are all the ones the map view uses. This file
 * only decides what to draw.
 *
 * ## The frame it draws in
 *
 * Metres, with the rider at the origin, `+y` the way they are travelling and `+x` to their
 * right. The component flips `y` and scales to pixels; nothing here knows about a screen. The
 * projection is a flat tangent plane, which over 400 m is wrong by far less than a GPS fix is.
 */

/** How much road ahead is drawn. A turn is in view from about the time it starts mattering. */
export const AHEAD_M = 320
/** And behind, faint, so the line visibly comes *from* somewhere rather than starting at the arrow. */
export const BEHIND_M = 60
/**
 * Off route, the stretch drawn either side of the nearest point on the route.
 *
 * Wider than the on-route window because the rider is not on it: what they need to see is which
 * side it lies on and which way it runs, and a 60 m stub could be pointing anywhere.
 */
export const OFF_ROUTE_SPAN_M = 250

/**
 * How far back the direction of travel is measured from.
 *
 * Behind the rider, not ahead. The view is heading-up, and a bearing taken *ahead* swings round
 * before the corner does — the line in front of the rider would rotate 40 m early and point a
 * left turn straight up the screen while they are still riding towards it. Measured over what
 * has just been ridden, the view turns once the rider has turned, which is what heading-up means.
 *
 * Short, because a chord lags a bend: 25 m was tried first, and on a twisting street the line
 * ahead set off at 60° across the screen with the arrow pointing straight up beside it. Not
 * the snapped segment's own bearing either — BRouter emits vertices a few metres apart at
 * junctions, and a segment that short turns the whole view on a single wobble of the snap.
 */
export const TRAVEL_LOOKBACK_M = 10

const EARTH_R = 6_371_000
const DEG = Math.PI / 180

export type Point = [x: number, y: number]

/** A `[lon, lat]` point in the rider's frame: metres right of them and metres ahead of them. */
export function toRiderFrame(
  origin: [number, number],
  bearingDeg: number,
  point: [number, number],
): Point {
  const east = (point[0] - origin[0]) * DEG * EARTH_R * Math.cos(origin[1] * DEG)
  const north = (point[1] - origin[1]) * DEG * EARTH_R
  const θ = bearingDeg * DEG
  return [east * Math.cos(θ) - north * Math.sin(θ), east * Math.sin(θ) + north * Math.cos(θ)]
}

/**
 * Which way the rider is going, from the route rather than from the fix.
 *
 * The route's own geometry over the last {@link TRAVEL_LOOKBACK_M}: a GPS course swings by tens
 * of degrees at walking pace and is null at a standstill, and a line that rotates every time the
 * fix wobbles is unreadable. At the very start there is nothing behind, so it looks ahead.
 */
export function travelBearing(geometry: RouteGeometry, alongM: number): number {
  if (alongM < TRAVEL_LOOKBACK_M) return routeBearingAhead(geometry, alongM)
  return bearingBetween(pointAt(geometry, alongM - TRAVEL_LOOKBACK_M), pointAt(geometry, alongM))
}

export interface GlanceLine {
  /** Already ridden, drawn faint. Empty off route, where "behind" is not a meaningful idea. */
  ridden: Point[]
  /** The line to follow. */
  ahead: Point[]
  /** The next actionable junction, if it falls inside what is drawn. */
  turn: { at: Point; turn: Turn } | null
  /** Off route only: the nearest point on the route, which the dotted line runs to. */
  rejoin: Point | null
}

/**
 * The line, in the rider's frame.
 *
 * On route the origin is the *snapped* point, not the fix: the rider then sits exactly on their
 * own line, where the raw fix would put the arrow a few metres either side of it and move it
 * every second. Off route the fix is the truth and the route is drawn where it actually is.
 */
export function glanceLine(input: {
  geometry: RouteGeometry
  alongM: number
  /** The snapped point on the route. */
  snapped: [number, number]
  /** The raw fix. Only used off route. */
  fix: [number, number]
  offRoute: boolean
  /** Up the screen, in degrees from north. */
  bearing: number
  turn: Turn | null
}): GlanceLine {
  const { geometry, alongM, snapped, fix, offRoute, bearing, turn } = input
  const origin = offRoute ? fix : snapped
  const frame = (coords: [number, number][]) => coords.map((c) => toRiderFrame(origin, bearing, c))

  if (offRoute) {
    return {
      ridden: [],
      ahead: frame(
        sliceAlong(
          geometry,
          Math.max(0, alongM - OFF_ROUTE_SPAN_M),
          Math.min(geometry.totalM, alongM + OFF_ROUTE_SPAN_M),
        ),
      ),
      turn: null,
      rejoin: toRiderFrame(origin, bearing, snapped),
    }
  }

  const aheadToM = Math.min(geometry.totalM, alongM + AHEAD_M)
  return {
    ridden: frame(sliceAlong(geometry, Math.max(0, alongM - BEHIND_M), alongM)),
    ahead: frame(sliceAlong(geometry, alongM, aheadToM)),
    turn:
      turn && turn.atM <= aheadToM
        ? { at: toRiderFrame(origin, bearing, pointAt(geometry, turn.atM)), turn }
        : null,
    rejoin: null,
  }
}

/**
 * How long before a turn the view lights up.
 *
 * Twice the speech's fifteen seconds (`LEAD_SECONDS` in `turns.ts`), floored at 120 m. The
 * screen should be bright *before* the voice speaks, so that a rider who hears "left in 100
 * metres" and glances down finds the turn already drawn at full strength — and a glance is
 * cheaper than an interruption, the same argument `CALLOUT_HORIZON_M` makes for climbs.
 */
export const NEAR_SECONDS = 30
export const NEAR_MIN_M = 120

export function nearDistanceM(speedMps: number | null): number {
  const speed = speedMps !== null && speedMps > 0.5 && speedMps < 30 ? speedMps : 15 / 3.6
  return Math.max(NEAR_MIN_M, speed * NEAR_SECONDS)
}

/**
 * - `near`: a turn is inside {@link nearDistanceM}. Full brightness.
 * - `far`: riding between turns, which is most of a ride. Everything dimmed.
 * - `off`: off route. The only state with a colour.
 * - `waiting`: no position on the route yet — before the first fix, or a route with no geometry.
 */
export type GlanceTone = 'near' | 'far' | 'off' | 'waiting'

export interface GlanceCue {
  tone: GlanceTone
  /** What the big glyph draws. */
  glyph: TurnKind
  /** The big number, in metres. Null while waiting. */
  distanceM: number | null
  /** The line under it. */
  words: string
  /** A second junction close behind the first, as the speech chains it. */
  then: Turn | null
}

/**
 * What the top of the glance view says.
 *
 * Far from a turn it says *keep going* — a straight arrow, the distance to the turn and the
 * turn's name underneath ("then right") — rather than drawing a left arrow 4 km before the
 * left. The line already shows the road bending when it bends; a turn glyph minutes early is a
 * claim about what to do now that is not true yet.
 *
 * A route with no turn instructions — a recorded track, an older save — has nothing to count
 * down to but the finish, and says so rather than inventing a junction.
 */
export function glanceCue(input: {
  tracking: boolean
  offRoute: boolean
  offsetM: number | null
  turns: Turn[]
  turnAhead: { turn: Turn; awayM: number } | null
  remainingM: number | null
  speedMps: number | null
  label: (turn: Turn) => string
}): GlanceCue {
  const { tracking, offRoute, offsetM, turns, turnAhead, remainingM, speedMps, label } = input

  if (!tracking) {
    return { tone: 'waiting', glyph: 'straight', distanceM: null, words: 'Finding you…', then: null }
  }

  if (offRoute) {
    return { tone: 'off', glyph: 'straight', distanceM: offsetM, words: 'Off route', then: null }
  }

  if (!turnAhead) {
    return {
      tone: remainingM !== null && remainingM <= nearDistanceM(speedMps) ? 'near' : 'far',
      glyph: 'end',
      distanceM: remainingM,
      words: 'Finish',
      then: null,
    }
  }

  const { turn, awayM } = turnAhead
  if (awayM > nearDistanceM(speedMps)) {
    return {
      tone: 'far',
      glyph: 'straight',
      distanceM: awayM,
      words: `then ${label(turn).toLowerCase()}`,
      then: null,
    }
  }

  const then =
    turns.find((t) => t.atM > turn.atM && t.atM - turn.atM <= CHAIN_WITHIN_M && isActionable(t)) ??
    null
  return { tone: 'near', glyph: turn.kind, distanceM: awayM, words: label(turn), then }
}

/**
 * The direction of the rejoin point from the rider, clockwise from straight up the screen.
 *
 * What the off-route arrow is rotated by. `0` when the point is the rider's own — a rider
 * standing exactly on the route is not off it, but the two judgements run on different fixes
 * and one second can disagree.
 */
export function rejoinAngle(rejoin: Point | null): number {
  if (!rejoin || (rejoin[0] === 0 && rejoin[1] === 0)) return 0
  return (Math.atan2(rejoin[0], rejoin[1]) * 180) / Math.PI
}

/** An SVG `points` attribute, in pixels, for a line in the rider's frame. */
export function svgPoints(points: Point[], pxPerM: number, origin: Point): string {
  return points
    .map(([x, y]) => `${(origin[0] + x * pxPerM).toFixed(1)},${(origin[1] - y * pxPerM).toFixed(1)}`)
    .join(' ')
}
