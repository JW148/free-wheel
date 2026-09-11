import { useMemo } from 'react'
import { gradients, type Gradient, type Severity } from './climbs'
import { routeGeometry } from './progress'
import type { ParsedRoute } from './gpx'
import { formatAway } from './format'
import { formatGrade, gradeColour } from './gradeScale'

/**
 * Every climb on the route, before you set off.
 *
 * The total-ascent figure in the stats rail is the number everyone quotes and it is nearly
 * useless on its own: 140 m spread over 9 km is a gentle afternoon and 140 m in two walls is a
 * different ride, and the number is identical. The elevation profile above shows the shape but
 * cannot be read precisely — a rider cannot tell 6% from 9% off a 96px chart with an
 * auto-scaled axis.
 *
 * So the climbs are listed, in order, with the three numbers that decide whether to take the
 * route: where it starts, how much it gains, and how steep it is. Exactly the same
 * `gradients()` output the riding HUD calls out one at a time — plan and ride describe the
 * road identically, which is the point.
 */

const SEVERITY_LABEL: Record<Severity, string> = {
  easy: 'easy',
  moderate: 'moderate',
  hard: 'hard',
  brutal: 'brutal',
}

export default function RouteClimbs({ route }: { route: ParsedRoute }) {
  const climbs = useMemo(() => {
    const geometry = routeGeometry(route)
    return geometry ? gradients(geometry).filter((g) => g.kind === 'climb') : []
  }, [route])

  if (climbs.length === 0) {
    return (
      <p className="section-label">
        Climbs — nothing steep enough to name. It is a flat one.
      </p>
    )
  }

  const steepest = climbs.reduce((worst, climb) =>
    climb.gainM * climb.grade > worst.gainM * worst.grade ? climb : worst,
  )

  return (
    <div>
      <p className="section-label">
        Climbs — {climbs.length}, the worst {Math.round(steepest.gainM)} m at{' '}
        {formatGrade(steepest.grade)}
      </p>
      <ol className="climb-list">
        {climbs.map((climb) => (
          <li key={climb.startM}>
            <span className="climb-bar" style={{ background: gradeColour(climb.grade) }} />
            <span className="climb-where">{formatAway(climb.startM)} in</span>
            <span className="climb-figures">
              <strong>
                {Math.round(climb.gainM)} m at {formatGrade(climb.grade)}
              </strong>
              {detail(climb)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The second line: how long it lasts, how hard it is, and the steepest bit if it is worse
 * than the average by enough to change the gear you would pick.
 */
function detail(climb: Gradient): string {
  const worse = climb.maxGrade > climb.grade + 0.02
  return [
    formatAway(climb.lengthM),
    SEVERITY_LABEL[climb.severity],
    worse ? `up to ${formatGrade(climb.maxGrade)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
