import { useMemo } from 'react'
import { formatDistance } from './gpx'
import type { ParsedRoute } from './gpx'
import { routeGeometry } from './progress'
import { breakdownOf, wayRuns, ROAD_COLOURS, type BreakdownRow, type RoadClass } from './ways'


/**
 * How much of the route is what.
 *
 * Under the climb list, because a climb changes the ride more than a surface does, and a
 * rider reading down this sheet is answering "can I do it" before "what will it be like".
 *
 * ## The table is the strip's legend
 *
 * The road rows carry the colour the strip drew them in. Four bands above a table of the same
 * four words is a puzzle solved by putting a swatch on each word, and that is cheaper than a
 * legend row — which would be a third element saying what two already say.
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
export default function RouteBreakdown({ route }: { route: ParsedRoute }) {
  const breakdown = useMemo(() => {
    const geometry = routeGeometry(route)
    const runs = geometry && wayRuns(route, geometry)
    return runs ? breakdownOf(runs) : null
  }, [route])

  // A route saved before the app asked BRouter for tags, or a recorded ride, which never had
  // any. Absent rather than an empty table: a table of nothing claims the route is nothing.
  if (!breakdown) return null

  return (
    <div className="breakdown">
      <p className="section-label">What it is made of</p>

      <Rows rows={breakdown.road} swatches />
      <Rows rows={breakdown.surface} />

      {breakdown.networkM > 0 && (
        <p className="breakdown-network">
          {formatDistance(breakdown.networkM)} on the National Cycle Network
        </p>
      )}
    </div>
  )
}

function Rows({ rows, swatches = false }: { rows: BreakdownRow[]; swatches?: boolean }) {
  return (
    <dl className="breakdown-rows">
      {rows.map((row) => (
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
          </dt>
          <dd>{formatDistance(row.metres)}</dd>
        </div>
      ))}
    </dl>
  )
}
