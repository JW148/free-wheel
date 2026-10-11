import { useEffect, useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import { workerUrl } from '../ride/useMapLibre'
import { sourceStats } from '../map/opfsPmtiles'
import { environmentNotes } from '../spike/runSpike'
import { formatBytes } from '../engine/tiles'
import RoutePanel from '../engine/RoutePanel'
import SpikePanel from '../spike/SpikePanel'
import { copyText, sendReport } from '../spike/report'
import {
  COUNTERS,
  COUNTER_LABELS,
  WINDOW_S,
  workload,
  workloadMarkdown,
  type WorkloadSnapshot,
} from '../ride/workload'

/**
 * What to look at when something is wrong.
 *
 * The counters here exist because of specific failures that were invisible without them: a
 * MapLibre worker that silently never started (Phase 3), and a PMTiles source that resolved
 * a header and then never read another byte. "The map is blank" is the same symptom for
 * both, and these numbers are what tell them apart.
 */
export default function DiagnosticsPanel({ basemap }: { basemap: ReturnType<typeof useMapLibre> }) {
  const notes = environmentNotes()
  const [reads, setReads] = useState({ reads: 0, bytes: 0, lastError: null as string | null })

  // `sourceStats` is a plain module-level object mutated by the protocol handler, so it has
  // to be polled — it is deliberately not React state, since a tile read must not schedule
  // a render on the map's hot path.
  useEffect(() => {
    const poll = setInterval(
      () => setReads({ reads: sourceStats.reads, bytes: sourceStats.bytes, lastError: sourceStats.lastError }),
      1000,
    )
    return () => clearInterval(poll)
  }, [])

  return (
    <>
      <section>
        <h2>Environment</h2>
        <dl className="env">
          {Object.entries(notes).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div>
            <dt>build</dt>
            <dd>{__BUILD_ID__}</dd>
          </div>
        </dl>
        <p className="setup-footer">
          Check the build stamp before trusting any result on a device — the service worker has
          served a stale bundle often enough to have cost three debugging sessions.
        </p>
      </section>

      <section>
        <h2>Map pipeline</h2>
        <dl className="env">
          <div>
            <dt>maplibre worker</dt>
            <dd className={basemap.workerProblem ? 'bad' : undefined}>
              {basemap.workerProblem ?? `ok — ${workerUrl}`}
            </dd>
          </div>
          <div>
            <dt>archives drawn</dt>
            <dd>
              {basemap.mounted.length === 0
                ? 'none mounted'
                : basemap.mounted
                    .map((name) => {
                      const archive = basemap.archives?.find((a) => a.name === name)
                      return archive ? `${name} (${formatBytes(archive.bytes)})` : name
                    })
                    .join(', ')}
            </dd>
          </div>
          <div>
            <dt>OPFS range reads</dt>
            <dd>
              {reads.reads} reads, {formatBytes(reads.bytes)}
            </dd>
          </div>
          {reads.lastError && (
            <div>
              <dt>last read error</dt>
              <dd className="bad">{reads.lastError}</dd>
            </div>
          )}
        </dl>
        <p className="setup-footer">
          Reads climbing while the map stays blank means the archive is decoding but covers
          nowhere near you. Reads stuck at a handful means the worker never started.
        </p>
      </section>

      <WorkloadSection notes={notes} />

      <RoutePanel />

      <SpikePanel notes={notes} />
    </>
  )
}

/**
 * How hard the last ride made the phone work.
 *
 * The riding screen has no way into Setup, on purpose, so this is read *after* a ride: the live
 * rates are whatever is happening now, and the last ride's figures are kept until the next one
 * starts. Mid-ride, the same numbers are on `window.freeWheelWorkload` for Safari's Web
 * Inspector. Polled once a second for the reason `sourceStats` is — see `workload.ts`.
 */
function WorkloadSection({ notes }: { notes: Record<string, string> }) {
  const [snapshot, setSnapshot] = useState<WorkloadSnapshot>(() => workload.snapshot())
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    const poll = setInterval(() => setSnapshot(workload.snapshot()), 1000)
    return () => clearInterval(poll)
  }, [])

  const ride = snapshot.lastRide
  return (
    <section>
      <h2>Ride workload</h2>
      <dl className="env">
        {COUNTERS.map((counter) => (
          <div key={counter}>
            <dt>{COUNTER_LABELS[counter]}</dt>
            <dd>
              {Math.round(snapshot.perMinute[counter])}/min now
              {ride ? ` · ${Math.round(ride.perMinute[counter])}/min last ride` : ''}
            </dd>
          </div>
        ))}
        {ride && (
          <div>
            <dt>last ride</dt>
            <dd>
              {Math.round(ride.durationS / 60)} min, {ride.totals.frames} frames,{' '}
              {ride.totals.fixes} fixes
            </dd>
          </div>
        )}
      </dl>
      <p className="setup-footer">
        "Now" is the last {WINDOW_S} seconds. A map at rest draws nothing, so frames per minute
        while riding is roughly how often the camera moved, and it is the figure the battery
        follows.
      </p>
      <div className="actions">
        <button
          onClick={async () => {
            const md = workloadMarkdown(workload.snapshot(), { ...notes, build: __BUILD_ID__ })
            try {
              setSent(`Sent → ${await sendReport(md)}`)
            } catch {
              setSent((await copyText(md)) ? 'Copied' : 'Could not send or copy')
            }
          }}
        >
          Send report
        </button>
        {sent && <p className="meta">{sent}</p>}
      </div>
    </section>
  )
}
