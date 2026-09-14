import { formatElapsed, formatEnergy, formatSpeed } from './format'
import { formatDistance } from './gpx'
import { kilocaloriesFrom } from './power'
import type { RideSummary } from './recording'

/**
 * What a ride came to, as six figures and a sentence.
 *
 * Extracted from the finish sheet the moment rides became things you could open again. The
 * numbers a rider wants a week later are exactly the numbers they wanted thirty seconds after
 * stopping, and two components would have drifted — the first ride whose average speed was
 * computed over elapsed time in one place and moving time in the other would be a bug nobody
 * could see, because the two screens are never on top of each other.
 *
 * ## The figures, and the two that are not here
 *
 * Distance, moving time, average and maximum speed, climbing, and work done. Not *average
 * gradient*, which is zero for every loop, and not *calories* as a figure of its own — it
 * appears inside the sentence with the near-identity spelled out, because quoting a calorie
 * figure alongside a kilojoule figure invites the reader to think they are two measurements
 * rather than one number twice.
 */
export default function RideStats({ summary }: { summary: RideSummary }) {
  return (
    <>
      <dl className="detail-stats summary-stats">
        <div>
          <dt>ridden</dt>
          <dd>{formatDistance(summary.distanceM)}</dd>
        </div>
        <div>
          <dt>moving</dt>
          <dd>{formatElapsed(summary.movingS)}</dd>
        </div>
        <div>
          <dt>avg km/h</dt>
          <dd>{formatSpeed(summary.avgSpeedMps)}</dd>
        </div>
        <div>
          <dt>max km/h</dt>
          <dd>{formatSpeed(summary.maxSpeedMps)}</dd>
        </div>
        <div>
          <dt>climbed</dt>
          <dd>{Math.round(summary.ascentM)} m</dd>
        </div>
        <div>
          <dt>elapsed</dt>
          <dd>{formatElapsed(summary.elapsedS)}</dd>
        </div>
      </dl>

      {summary.avgPowerW !== null && summary.energyKj > 0 && (
        <p className="summary-effort">
          About <strong>{Math.round(summary.avgPowerW / 5) * 5} W</strong> average and{' '}
          <strong>{formatEnergy(summary.energyKj)} kJ</strong> of work — roughly{' '}
          {Math.round(kilocaloriesFrom(summary.energyKj))} Calories, which is the same number
          because a cyclist is about 24% efficient. Estimated from speed, gradient and your
          weight; it is not a power meter.
        </p>
      )}
    </>
  )
}

/** `Sunday 8 Sep, 17:41` — when a ride happened, which is how a rider recognises one. */
export function rideWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
