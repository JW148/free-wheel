import { useMemo } from 'react'
import type { Gradient } from './climbs'
import { elevationAt, gradeAt, type RideProgress, type RouteGeometry } from './progress'
import { gradeColour } from './gradeScale'
import { formatAway } from './format'

/**
 * The road ahead, and where you are on the whole ride.
 *
 * Two bands, answering two different questions, because one chart cannot answer both:
 *
 * - **The lookahead** ({@link RideProfile}) is the next few kilometres, magnified. This is the
 *   question the user actually asked for — "is there a massive hill coming up, or a break on
 *   the downhill" — and it is unanswerable from a whole-route profile, where the next 2 km of
 *   a 90 km ride is four pixels wide.
 * - **The overview** ({@link RouteOverview}) is the whole route as a 6 px bar: how far through
 *   you are, and where the remaining climbs sit. It is what stops the lookahead from being
 *   disorienting, because a magnified window with no context does not tell you whether you are
 *   nearly home.
 *
 * They were one SVG until the HUD learned to collapse. The collapsed HUD keeps the overview
 * and drops the lookahead — progress and the shape of what is left are worth 10 px of screen
 * even when the graph is not — so the two bands are now two components. They still share this
 * comment, because they are still one design.
 *
 * ## Severity is in the colour, not the shape
 *
 * The lookahead auto-scales vertically — it has to, or a real 25 m rise over 2 km renders as a
 * flat line. That means the *slope on screen* is not the gradient, so severity moves to
 * colour, which is absolute. See `gradeScale.ts`. It also means the two bands cannot share a
 * scale, which is fine: they are not comparing, they are describing.
 *
 * ## Why bars rather than a smooth area
 *
 * Each bar is one slice of road with one colour. A smooth filled area would need a gradient
 * fill per segment to carry the same information, and at 47 m per slice the stepping is not
 * visible anyway — what is visible is the colour changing where the road does.
 */

const WIDTH = 320
const AHEAD_HEIGHT = 68
const OVERVIEW_HEIGHT = 8

/** Slices across the lookahead. 64 is about two per device pixel at the width this draws at. */
const SLICES = 64

/**
 * How far ahead to show by default.
 *
 * 3 km is roughly eight minutes of riding, which is the horizon a decision is made on: long
 * enough to see the climb coming and change gear, short enough that the ramp is not four
 * pixels wide. It shrinks near the finish so the end of the route is visible rather than
 * off the edge of a window that runs past it.
 */
const LOOKAHEAD_M = 3000
const MIN_WINDOW_M = 400

/** A flat lookahead still gets this much vertical room, so flat reads as flat. */
const MIN_BAND_M = 18

export default function RideProfile({
  geometry,
  progress,
}: {
  geometry: RouteGeometry
  progress: RideProgress
}) {
  // Quantised to 25 m, which is the resampling step everything upstream already works in.
  // Without it the 64 slices are recomputed on every fix and the bars shimmer by a fraction
  // of a pixel each second — visible, and pure waste.
  const alongM = Math.round(progress.position.alongM / 25) * 25
  const windowM = Math.max(MIN_WINDOW_M, Math.min(LOOKAHEAD_M, progress.remainingM))

  const slices = useMemo(() => {
    const step = windowM / SLICES
    return Array.from({ length: SLICES }, (_, i) => {
      const at = alongM + i * step
      return {
        at,
        elevM: elevationAt(geometry, at),
        grade: gradeAt(geometry, at + step / 2),
      }
    })
  }, [geometry, alongM, windowM])

  const heights = slices.map((s) => s.elevM)
  const low = Math.min(...heights)
  const high = Math.max(...heights)
  const band = Math.max(high - low, MIN_BAND_M)
  // A little headroom, so a summit inside the window does not touch the top edge and read as
  // if it carried on rising off the chart.
  const floor = low - band * 0.12
  const span = band * 1.24

  const y = (elevM: number) => AHEAD_HEIGHT - ((elevM - floor) / span) * AHEAD_HEIGHT
  const barWidth = WIDTH / SLICES

  /** Kilometre marks inside the window, so the horizontal scale is readable. */
  const ticks: number[] = []
  for (let km = Math.ceil(alongM / 1000) * 1000; km < alongM + windowM; km += 1000) {
    ticks.push(km)
  }

  return (
    <svg
      className="ride-profile"
      viewBox={`0 0 ${WIDTH} ${AHEAD_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={aheadLabel(windowM, low, high)}
    >
      {slices.map((slice, i) => (
        <rect
          key={slice.at}
          x={i * barWidth}
          // Half a pixel of overlap: adjacent rects with fractional widths leave hairline
          // gaps otherwise, and 64 hairlines read as a dotted chart.
          width={barWidth + 0.5}
          y={y(slice.elevM)}
          height={Math.max(0, AHEAD_HEIGHT - y(slice.elevM))}
          fill={gradeColour(slice.grade)}
          fillOpacity={0.85}
        />
      ))}

      {ticks.map((at) => (
        <line
          key={at}
          x1={((at - alongM) / windowM) * WIDTH}
          x2={((at - alongM) / windowM) * WIDTH}
          y1={0}
          y2={AHEAD_HEIGHT}
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {/* The rider, pinned to the left edge: the window starts where they are, so this is a
          fixed mark rather than a moving one. Drawn anyway, because without it the leftmost
          bar reads as the start of the route. */}
      <line
        x1={1}
        x2={1}
        y1={0}
        y2={AHEAD_HEIGHT}
        stroke="currentColor"
        strokeOpacity={0.85}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/**
 * The whole route as a bar: how far through, and where the climbs that are left sit.
 *
 * The one thing the collapsed HUD keeps. It is 10 px tall and answers the question a rider
 * asks most often — am I nearly there — which is why hiding the graph does not mean hiding
 * this.
 */
export function RouteOverview({
  geometry,
  progress,
  climbs,
}: {
  geometry: RouteGeometry
  progress: RideProgress
  climbs: Gradient[]
}) {
  return (
    <svg
      className="ride-overview"
      viewBox={`0 0 ${WIDTH} ${OVERVIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={overviewLabel(progress)}
    >
      <rect
        x={0}
        y={0}
        width={WIDTH}
        height={OVERVIEW_HEIGHT}
        rx={OVERVIEW_HEIGHT / 2}
        fill="currentColor"
        fillOpacity={0.15}
      />
      {climbs
        .filter((climb) => climb.kind === 'climb')
        .map((climb) => (
          <rect
            key={climb.startM}
            x={(climb.startM / geometry.totalM) * WIDTH}
            width={Math.max(2, ((climb.endM - climb.startM) / geometry.totalM) * WIDTH)}
            y={0}
            height={OVERVIEW_HEIGHT}
            fill={gradeColour(climb.grade)}
            fillOpacity={0.9}
          />
        ))}
      <rect
        x={0}
        y={0}
        width={Math.max(0, progress.fraction * WIDTH)}
        height={OVERVIEW_HEIGHT}
        rx={OVERVIEW_HEIGHT / 2}
        fill="currentColor"
        fillOpacity={0.55}
      />
    </svg>
  )
}

function aheadLabel(windowM: number, low: number, high: number): string {
  const climb = high - low > 5 ? `, rising ${Math.round(high - low)} metres` : ', roughly level'
  return `The next ${formatAway(windowM)}${climb}.`
}

function overviewLabel(progress: RideProgress): string {
  return `${Math.round(progress.fraction * 100)}% of the route ridden, ${formatAway(progress.remainingM)} to go.`
}
