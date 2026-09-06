import { useEffect, useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import { workerUrl } from '../ride/useMapLibre'
import { sourceStats } from '../map/opfsPmtiles'
import { environmentNotes } from '../spike/runSpike'
import { formatBytes } from '../engine/tiles'
import RoutePanel from '../engine/RoutePanel'
import SpikePanel from '../spike/SpikePanel'

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
        <p className="meta">
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
            <dt>archive</dt>
            <dd>{basemap.active ? `${basemap.active.name} (${formatBytes(basemap.active.bytes)})` : 'none mounted'}</dd>
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
        <p className="meta">
          Reads climbing while the map stays blank means the archive is decoding but covers
          nowhere near you. Reads stuck at a handful means the worker never started.
        </p>
      </section>

      <RoutePanel />

      <SpikePanel notes={notes} />
    </>
  )
}
