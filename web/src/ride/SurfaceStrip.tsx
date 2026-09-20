import { ROAD_COLOURS, type WayRun } from './ways'

/**
 * What the route is made of, along the same axis as its elevation.
 *
 * A band under the elevation chart, sharing its width and its x-axis exactly, so the two are
 * read together: the drag that asks "how bad is the bit at 8 km" now answers with the gradient
 * *and* the road. That is the whole reason it is here rather than being a chart of its own —
 * separated, a rider has to match two x-axes by eye, which is the thing the climb list used to
 * make them do before the climbs were marked on the profile itself.
 *
 * ## Why it carries road class and not surface
 *
 * Two reasons, and the first is that it is the question that was asked: the map does not make
 * it clear whether you are on a cycle path. The second is coverage. Surface already has a
 * treatment on the map — the dashes — where road class only has the main-road casing, so
 * colouring the strip by class is what leaves both dimensions visible somewhere. Surface is in
 * the readout, in the table, and on the line.
 *
 * Four classes exactly, because `highway` is always tagged. There is no unknown road the way
 * there is an unknown surface, which is also why the strip can tile the route with no gaps.
 */

/** Matches `ElevationProfile`'s viewBox, because the two are read as one axis. */
const WIDTH = 320
const HEIGHT = 10

export default function SurfaceStrip({
  runs,
  totalM,
  cursorM,
}: {
  runs: WayRun[]
  totalM: number
  /** Where the finger is on the elevation chart above, so the strip can mark the same place. */
  cursorM: number | null
}) {
  if (runs.length === 0 || totalM <= 0) return null

  return (
    <svg
      className="surface-strip"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={describe(runs, totalM)}
    >
      {runs.map((run) => (
        <rect
          key={run.fromM}
          x={(run.fromM / totalM) * WIDTH}
          // A hairline of overlap. Neighbouring rects at fractional pixel boundaries leave a
          // one-pixel seam of background between them, and a strip of 600 runs is 600 seams —
          // which reads as a dashed bar rather than a solid one.
          width={((run.toM - run.fromM) / totalM) * WIDTH + 0.5}
          y={0}
          height={HEIGHT}
          fill={ROAD_COLOURS[run.road]}
        />
      ))}
      {cursorM !== null && (
        <rect
          className="surface-strip-cursor"
          x={(cursorM / totalM) * WIDTH - 0.75}
          width={1.5}
          y={0}
          height={HEIGHT}
        />
      )}
    </svg>
  )
}

/**
 * The strip in words, for a screen reader.
 *
 * The longest two classes rather than all four: read aloud, a full breakdown is the table
 * below repeated, and the table is the thing that has the numbers.
 */
function describe(runs: WayRun[], totalM: number): string {
  const totals = new Map<string, number>()
  for (const run of runs) {
    totals.set(run.road, (totals.get(run.road) ?? 0) + (run.toM - run.fromM))
  }
  const top = [...totals]
    .sort((one, two) => two[1] - one[1])
    .slice(0, 2)
    .map(([road, metres]) => `${Math.round((metres / totalM) * 100)}% ${road.replace('cyclepath', 'cycle path')}`)
  return `What the route is made of: mostly ${top.join(' and ')}.`
}
