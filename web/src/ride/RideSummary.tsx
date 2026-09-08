import { useState } from 'react'
import { Drawer } from 'vaul'
import { formatElapsed, formatEnergy, formatSpeed } from './format'
import { formatDistance } from './gpx'
import { kilocaloriesFrom } from './power'
import { rideEntry, putEntry } from './library'
import { traceToGpx, worthKeeping, type RideRecord, type RideSummary } from './recording'
import { shareGpx } from './share'

/**
 * What the ride was, offered once, at the moment it ends.
 *
 * ## Why a sheet and not a screen you can go back to
 *
 * Because the decision is "keep this or not", and it is only interesting for about thirty
 * seconds. A rider who wants the ride keeps it and it goes in the library; a rider who tapped
 * Start by accident dismisses it. Making it a permanent screen would mean a nav item, a
 * back-stack, and an empty state, for a thing looked at once.
 *
 * A ride under 200 m is not offered at all (`worthKeeping`): that is a mis-tap, and asking
 * someone whether they want to keep a 40 m ride is worse than silently discarding it.
 *
 * ## The figures, and the two that are not here
 *
 * Distance, moving time, average and maximum speed, climbing, and work done. Not *average
 * gradient*, which is zero for every loop, and not *calories*, which appears as kJ with the
 * near-identity spelled out — quoting a calorie figure alongside a kilojoule figure invites
 * the reader to think they are two measurements rather than one number twice.
 */
export default function RideSummarySheet({
  summary,
  record,
  onDismiss,
}: {
  summary: RideSummary
  record: RideRecord
  onDismiss: () => void
}) {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const keepable = worthKeeping(record)

  const save = async () => {
    try {
      await putEntry(
        rideEntry({ name, summary, gpx: traceToGpx(record, name || 'free-wheel ride'), trace: record.trace }),
      )
      setSaved(true)
    } catch (e) {
      // The ride is still on screen and still exportable. Say what happened rather than
      // pretending it saved.
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Drawer.Root open onOpenChange={(open) => !open && onDismiss()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer" aria-describedby={undefined}>
          <Drawer.Handle className="drawer-handle" />
          <div className="drawer-body">
            <div className="drawer-head">
              <Drawer.Title className="drawer-title">
                {keepable ? 'Ride finished' : 'That was a short one'}
              </Drawer.Title>
              <button type="button" className="primary" onClick={onDismiss}>
                Done
              </button>
            </div>

            <dl className="detail-stats summary-stats">
              <div>
                <dd>{formatDistance(summary.distanceM)}</dd>
                <dt>ridden</dt>
              </div>
              <div>
                <dd>{formatElapsed(summary.movingS)}</dd>
                <dt>moving</dt>
              </div>
              <div>
                <dd>{formatSpeed(summary.avgSpeedMps)}</dd>
                <dt>avg km/h</dt>
              </div>
              <div>
                <dd>{formatSpeed(summary.maxSpeedMps)}</dd>
                <dt>max km/h</dt>
              </div>
              <div>
                <dd>{Math.round(summary.ascentM)} m</dd>
                <dt>climbed</dt>
              </div>
              <div>
                <dd>{formatElapsed(summary.elapsedS)}</dd>
                <dt>elapsed</dt>
              </div>
            </dl>

            {summary.avgPowerW !== null && summary.energyKj > 0 && (
              <p className="summary-effort">
                About <strong>{Math.round(summary.avgPowerW / 5) * 5} W</strong> average and{' '}
                <strong>{formatEnergy(summary.energyKj)} kJ</strong> of work — roughly{' '}
                {Math.round(kilocaloriesFrom(summary.energyKj))} Calories, which is the same
                number because a cyclist is about 24% efficient. Estimated from speed, gradient
                and your weight; it is not a power meter.
              </p>
            )}

            {keepable ? (
              saved ? (
                <p className="warn">Saved. It is in the library, under Routes and rides.</p>
              ) : (
                <>
                  <label className="named-save">
                    <span className="section-label">Name it, or leave it blank</span>
                    <input
                      type="text"
                      value={name}
                      placeholder="Tuesday evening loop"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <div className="sheet-actions">
                    <button type="button" className="primary" onClick={() => void save()}>
                      Save this ride
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void shareGpx(
                          traceToGpx(record, name || 'free-wheel ride'),
                          `free-wheel-ride-${new Date(summary.startedAt).toISOString().slice(0, 10)}`,
                        )
                      }
                    >
                      Export GPX
                    </button>
                  </div>
                </>
              )
            ) : (
              <p className="warn">
                Under 200 m, so there is nothing worth keeping. Nothing was recorded.
              </p>
            )}

            {problem && (
              <p className="warn" role="alert">
                Could not save it: {problem}
              </p>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
