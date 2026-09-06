import { useMemo } from 'react'
import { elevationComparison } from './elevation'
import { formatDistance } from './gpx'
import type { ParsedRoute } from './gpx'
import { profileById } from './profiles'

/**
 * Every compared route's climbs, on one pair of axes.
 *
 * This answers the question the comparison list cannot: the list gives you three ascent
 * totals, but 120 m spread evenly is a different ride from 120 m in one wall, and the number
 * is identical either way. The shape is the thing being compared, so the shapes go on top of
 * each other.
 *
 * Lines only — no filled areas. Six translucent fills stacked over one another produce a
 * colour at every crossing that belongs to no route, which is the exact opposite of telling
 * them apart. The single-route chart in {@link ElevationProfile} keeps its fill because there
 * is nothing for it to muddle with.
 *
 * The legend doubles as a picker. Having read the chart, "that one" is the next thing you
 * want to say, and the nearest control should accept it.
 */

const WIDTH = 320
const HEIGHT = 104
const PAD_TOP = 8
const PAD_BOTTOM = 10

export default function ElevationCompare({
  routes,
  chosen,
  onChoose,
}: {
  routes: Record<string, ParsedRoute>
  /** The committed route, drawn thicker. `null` while the rider is still deciding. */
  chosen: string | null
  onChoose: (id: string) => void
}) {
  const comparison = useMemo(() => elevationComparison(routes), [routes])
  if (!comparison) return null

  const { series, maxDistanceM, minElevM, maxElevM } = comparison
  // A flat set would otherwise divide by zero, and render as a line along the bottom edge
  // implying a cliff. Give it a nominal band so flat reads as flat.
  const span = Math.max(maxElevM - minElevM, 10)
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM

  const x = (distanceM: number) => (distanceM / maxDistanceM) * WIDTH
  const y = (elevM: number) => PAD_TOP + plotHeight - ((elevM - minElevM) / span) * plotHeight

  // The chosen route last, so it is drawn over the ones it was picked against.
  const ordered = [...series].sort(
    (a, b) => Number(a.id === chosen) - Number(b.id === chosen),
  )

  return (
    <div className="elevation-compare">
      <p className="section-label">Climbs compared</p>

      <svg
        className="elevation elevation-multi"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Elevation of ${series.length} routes compared: ${Math.round(minElevM)} to ${Math.round(maxElevM)} metres over ${formatDistance(maxDistanceM)}`}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={WIDTH}
            y1={PAD_TOP + plotHeight * f}
            y2={PAD_TOP + plotHeight * f}
            stroke="currentColor"
            strokeOpacity="0.1"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {ordered.map((line) => (
          <path
            key={line.id}
            d={`M${line.points.map((p) => `${x(p.distanceM).toFixed(2)},${y(p.elevM).toFixed(2)}`).join(' L')}`}
            fill="none"
            stroke={profileById(line.id).colour}
            // Once one route is chosen the rest are context, exactly as on the map. Before
            // that they are equals and none of them is turned down.
            strokeOpacity={chosen === null || line.id === chosen ? 1 : 0.5}
            strokeWidth={line.id === chosen ? 2.5 : 1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <p className="elevation-summary">
        <span>{Math.round(minElevM)} m</span>
        <span>{formatDistance(maxDistanceM)}</span>
        <span>{Math.round(maxElevM)} m</span>
      </p>

      <div className="compare-legend">
        {series.map((line) => {
          const profile = profileById(line.id)
          return (
            <button
              key={line.id}
              type="button"
              className="legend-item"
              data-chosen={line.id === chosen ? 'yes' : 'no'}
              onClick={() => onChoose(line.id)}
              // Distinct from the identical action on the list row below, which reads
              // "Choose … and see its detail" — two controls with the same name in a rotor
              // is a needless coin toss.
              aria-label={`Choose ${profile.label} from the chart`}
            >
              <span className="swatch" style={{ background: profile.colour }} />
              {profile.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
