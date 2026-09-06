import { useId, useMemo, useRef, useState } from 'react'
import { elevationProfile } from './elevation'
import { formatDistance } from './gpx'
import type { ParsedRoute } from './gpx'

/**
 * The route's elevation, as an area chart.
 *
 * Inline SVG rather than a charting library: the app must work offline and every kilobyte is
 * precached, and this is one series with no axes worth the name. A chart library would be
 * more code than the chart.
 *
 * One series, so there is no legend — but the series has to be *named*, and drawn in the same
 * colour as its line on the map. Without that, a comparison of six profiles put a graph on
 * screen that described one of them and said nothing about which. The heading and the stroke
 * are the two places a rider looks, so both carry the identity.
 *
 * The readout replaces a tooltip: on a phone there is no hover, so dragging along the profile
 * is the equivalent gesture, and it answers the question actually being asked ("how bad is
 * the bit at 8 km?").
 */

const WIDTH = 320
const HEIGHT = 96
const PAD_TOP = 10
const PAD_BOTTOM = 16

/** The near-white a lone route is drawn in, for when there is no profile colour to match. */
const NEUTRAL = '#ccd0cf'

export default function ElevationProfile({
  route,
  colour = NEUTRAL,
  label,
}: {
  route: ParsedRoute
  /** The colour of this route's line on the map, so the two are obviously the same thing. */
  colour?: string
  /** The profile's name, for the heading. Omitted when there is only ever one route. */
  label?: string
}) {
  const svg = useRef<SVGSVGElement | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  // The gradient is referenced by id from `fill`, so it has to be unique per instance or a
  // second profile on screen would silently paint itself with the first one's colour.
  // `url(#…)` is a literal IDREF rather than a selector, so React's punctuation is stripped
  // rather than escaped — escaping it would stop it matching the `id` attribute at all.
  const gradientId = `elev-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  const profile = useMemo(() => elevationProfile(route), [route])

  if (!profile || profile.totalDistanceM === 0) return null

  const { points, minElevM, maxElevM, totalDistanceM } = profile
  // A flat route would otherwise divide by zero and, worse, render as a line along the
  // bottom edge implying a cliff. Give it a nominal band so it reads as flat.
  const span = Math.max(maxElevM - minElevM, 10)
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM

  const x = (distanceM: number) => (distanceM / totalDistanceM) * WIDTH
  const y = (elevM: number) => PAD_TOP + plotHeight - ((elevM - minElevM) / span) * plotHeight

  const line = points.map((p) => `${x(p.distanceM).toFixed(2)},${y(p.elevM).toFixed(2)}`).join(' L')
  const area = `M${line} L${WIDTH},${HEIGHT - PAD_BOTTOM} L0,${HEIGHT - PAD_BOTTOM} Z`

  const track = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect()
    if (!box) return
    const ratio = Math.min(Math.max((clientX - box.left) / box.width, 0), 1)
    setCursor(ratio * totalDistanceM)
  }

  // Nearest sample to the finger, so the readout matches the mark under it.
  const at =
    cursor === null
      ? null
      : points.reduce((best, p) =>
          Math.abs(p.distanceM - cursor) < Math.abs(best.distanceM - cursor) ? p : best,
        )

  return (
    <div>
      <p className="section-label">
        {label ? `Elevation — ${label}` : 'Elevation'}
        {at && (
          <span className="elevation-readout">
            {' · '}
            {formatDistance(at.distanceM)} at {Math.round(at.elevM)} m
          </span>
        )}
      </p>

      <svg
        ref={svg}
        className="elevation"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Elevation profile${label ? ` for ${label}` : ''}: ${Math.round(minElevM)} to ${Math.round(maxElevM)} metres over ${formatDistance(totalDistanceM)}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          track(e.clientX)
        }}
        onPointerMove={(e) => {
          if (e.buttons > 0 || e.pointerType === 'touch') track(e.clientX)
        }}
        onPointerUp={() => setCursor(null)}
        onPointerCancel={() => setCursor(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.4" />
            <stop offset="100%" stopColor={colour} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Recessive gridlines at the quarter points — enough to judge a gradient by, not
            enough to compete with the profile itself. */}
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

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={`M${line}`}
          fill="none"
          stroke={colour}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {at && (
          <>
            <line
              x1={x(at.distanceM)}
              x2={x(at.distanceM)}
              y1={PAD_TOP - 4}
              y2={HEIGHT - PAD_BOTTOM}
              stroke="currentColor"
              strokeOpacity="0.5"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* A surface-coloured ring keeps the marker legible wherever it lands on the
                fill. */}
            <circle
              cx={x(at.distanceM)}
              cy={y(at.elevM)}
              r="4"
              fill={colour}
              stroke="#11212d"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      <p className="elevation-summary">
        <span>{Math.round(minElevM)} m</span>
        <span>{formatDistance(totalDistanceM)}</span>
        <span>{Math.round(maxElevM)} m</span>
      </p>
    </div>
  )
}
