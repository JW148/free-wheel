import { useMemo } from 'react'
import { formatDistance } from './gpx'
import type { ParsedRoute } from './gpx'
import { routeGeometry } from './progress'
import { breakdownOf, wayRuns, ROAD_COLOURS, type BreakdownRow, type RoadClass } from './ways'

/**
 * How much of the route is what.
 *
 * ## Directly under the strip, and that beat the argument it used to sit behind
 *
 * This was below the climb list, on the reasoning that a climb changes the ride more than a
 * surface does. That reasoning is fine and it lost to a better one: the road rows carry the
 * strip's colours, so this table *is* the strip's legend, and a legend a scroll away from the
 * thing it explains is not a legend. Four coloured bands you have to go looking to decode are
 * a puzzle, and the first thing a rider does with a puzzle is stop looking at it.
 *
 * The two arguments were never equal. Climb ordering is a preference about what to read
 * first; legend adjacency is what makes the strip mean anything at all.
 *
 * ## Two groups, each named
 *
 * Road and surface are different questions and the gap between them was the only thing saying
 * so. `Road` sits first because it is the group the strip is coloured by, so the swatches land
 * immediately under the bands they explain.
 *
 * ## It is the legend for the map as well, and that is the harder job
 *
 * The strip speaks in colour and the map speaks in texture, because the map cannot have four
 * more hues — six route colours at C >= 45 already fill the usable circle under the ΔE >= 16
 * clearance floor, and the region work found there is not even a fourth *region* colour going
 * spare. Two languages for one fact is a seam a rider can feel, and the first report back was
 * exactly that: the line and the table do not look like they are about the same thing.
 *
 * So the rows that produce a map mark carry a drawing of it, in the route's own colour. Two
 * samples, because only two things are ever marked — and seeing only two samples in a table of
 * eight rows is itself the explanation of why the line is quiet everywhere else.
 *
 * ## Why `Not recorded` earns a row here and gets no mark on the map
 *
 * It is not a claim about the road, it is a fact about the map. On the London to Brighton
 * reference route a quarter of the distance — 23 of 95 km — has no `surface` tag at all, and a
 * rider who can see that reads the rest of the table differently. The map cannot say the same
 * thing: a dash there would be an assertion that the road is rough, invented out of a gap in
 * OpenStreetMap. So the table states it and the line stays quiet.
 *
 * ## Membership, never a number
 *
 * The routing tiles carry `route_bicycle_ncn=yes` and nothing else — no route number exists in
 * this data. So the line says "on the National Cycle Network" and cannot say "NCN 20", even
 * where that is exactly what it is.
 */
export default function RouteBreakdown({
  route,
  colour,
}: {
  route: ParsedRoute
  /** The route's own line colour, so the map samples are drawn in the line they describe. */
  colour: string
}) {
  const breakdown = useMemo(() => {
    const geometry = routeGeometry(route)
    const runs = geometry && wayRuns(route, geometry)
    return runs ? breakdownOf(runs) : null
  }, [route])

  // A route saved before the app asked BRouter for tags, or a recorded ride, which never had
  // any. Absent rather than an empty table: a table of nothing claims the route is nothing.
  if (!breakdown) return null

  const marked = [...breakdown.road, ...breakdown.surface].some((row) => markFor(row.key))

  return (
    <div className="breakdown">
      <p className="section-label">Road</p>
      <Rows rows={breakdown.road} colour={colour} swatches />

      <p className="section-label">Surface</p>
      <Rows rows={breakdown.surface} colour={colour} />

      {/* Not "the only two", which is what this said first: there are two *marks* but three
          rows can carry one, because cobbles and unpaved share a dash. A reader counts rows. */}
      {marked && (
        <p className="breakdown-note">
          The map marks only these stretches. The rest of the route is drawn plain.
        </p>
      )}

      {breakdown.networkM > 0 && (
        <p className="breakdown-network">
          {formatDistance(breakdown.networkM)} on the National Cycle Network
        </p>
      )}
    </div>
  )
}

/**
 * Which map mark a row's class produces, if any.
 *
 * `loose` and `rough` both come back as `unpaved` because the map folds them together — the
 * rider's question is whether it will be slow and jarring, and the answer is the same. Kept in
 * step with `markedRuns` in `ways.ts`, which is the code that actually decides.
 */
function markFor(key: BreakdownRow['key']): 'unpaved' | 'main' | null {
  if (key === 'main') return 'main'
  if (key === 'loose' || key === 'rough') return 'unpaved'
  return null
}

function Rows({
  rows,
  colour,
  swatches = false,
}: {
  rows: BreakdownRow[]
  colour: string
  swatches?: boolean
}) {
  return (
    <dl className="breakdown-rows">
      {rows.map((row) => {
        const mark = markFor(row.key)
        return (
          // `<dt>` then `<dd>`, which is the correct order for a description list and the one
          // this project got backwards from phase 4 until phase 11.
          <div key={row.key}>
            <dt>
              {swatches && (
                <span
                  className="breakdown-swatch"
                  style={{ background: ROAD_COLOURS[row.key as RoadClass] }}
                />
              )}
              {row.label}
              {mark && <MarkSample mark={mark} colour={colour} />}
            </dt>
            <dd>{formatDistance(row.metres)}</dd>
          </div>
        )
      })}
    </dl>
  )
}

/**
 * How the map draws this stretch, at about an inch.
 *
 * Deliberately a *drawing* rather than an icon: the dash spacing and the flanking pair are the
 * same shapes `routeLayers.ts` puts on the line, so a rider who has seen one recognises the
 * other. Drawn in the route's own colour for the same reason the swatch carries the strip's.
 *
 * `--text` for the mark, which is where the map's overlay ink ends up too: near-black on the
 * light theme and near-white on the dark one, turning over with everything else.
 */
function MarkSample({ mark, colour }: { mark: 'unpaved' | 'main'; colour: string }) {
  return (
    <svg
      className="breakdown-sample"
      viewBox="0 0 30 14"
      aria-label={mark === 'unpaved' ? 'drawn dashed on the map' : 'drawn heavier on the map'}
      role="img"
    >
      {/* The core is narrower under the flanks than under the dash, for the reason the map
          needs it to be: the flanks sit *outside* the line, and at this size a 5-wide core
          leaves them touching it, which reads as one thick bar rather than a line with edges. */}
      <path
        d="M1 7 H29"
        stroke={colour}
        strokeWidth={mark === 'unpaved' ? 5 : 4}
        strokeLinecap="round"
        fill="none"
      />
      {mark === 'unpaved' ? (
        <path
          d="M2 7 H28"
          stroke="var(--text)"
          strokeWidth={1.6}
          strokeDasharray="3 3"
          fill="none"
        />
      ) : (
        <path
          d="M1 3 H29 M1 11 H29"
          stroke="var(--text)"
          strokeWidth={1.4}
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  )
}
