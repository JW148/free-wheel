import { useMemo, useRef, useState } from 'react'
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
 * One series, so there is no legend — the heading names it. The readout replaces a tooltip:
 * on a phone there is no hover, so dragging along the profile is the equivalent gesture, and
 * it answers the question actually being asked ("how bad is the bit at 8 km?").
 */

const WIDTH = 320
const HEIGHT = 96
const PAD_TOP = 10
const PAD_BOTTOM = 16

export default function ElevationProfile({ route }: { route: ParsedRoute }) {
  const svg = useRef<SVGSVGElement | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)

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
        Elevation
        {at && (
          <span className="elevation-readout">
            {' — '}
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
        aria-label={`Elevation profile: ${Math.round(minElevM)} to ${Math.round(maxElevM)} metres over ${formatDistance(totalDistanceM)}`}
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
          <linearGradient id="elevation-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e8590c" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#e8590c" stopOpacity="0.02" />
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

        <path d={area} fill="url(#elevation-fill)" />
        <path
          d={`M${line}`}
          fill="none"
          stroke="#e8590c"
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
              fill="#e8590c"
              stroke="#0d1116"
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
