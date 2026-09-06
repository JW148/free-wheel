import { useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import { sharedEngine } from '../engine/engineClient'
import { formatBytes } from '../engine/tiles'
import type { ImportProgress } from '../engine/tileStore'

/**
 * Importing and choosing the basemap archive.
 *
 * The map itself lives on the ride screen; this only manages which archive is behind it.
 * Importing one switches to it immediately, because that is invariably what you meant.
 */
export default function BasemapPanel({ basemap }: { basemap: ReturnType<typeof useMapLibre> }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <section>
      <h2>Basemap</h2>
      <p className="sub">
        The map you see, as a PMTiles archive stored on the phone. Build one with{' '}
        <code>pmtiles extract</code> and import it here — there is no tile server, so what is
        imported is exactly what you can see.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <label className="filebutton">
          Import .pmtiles…
          <input
            type="file"
            accept=".pmtiles"
            multiple
            disabled={busy}
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])]
              // Reading `e.target.files` after this point returns nothing, so the list is
              // captured first.
              e.target.value = ''
              if (!files.length) return
              setBusy(true)
              setError(null)
              try {
                const result = await sharedEngine().importBasemaps(files, (p: ImportProgress) =>
                  setProgress(`${p.tile}: ${formatBytes(p.received)} of ${formatBytes(p.total)}`),
                )
                if (result.failed.length) {
                  setError(result.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))
                }
                await basemap.refresh()
                if (result.imported[0]) await basemap.show(result.imported[0])
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
                setProgress(null)
              }
            }}
          />
        </label>
      </div>

      {progress && <p className="meta">{progress}</p>}

      {basemap.archives.length === 0 ? (
        <p className="meta">Nothing imported yet.</p>
      ) : (
        <ul className="tilelist">
          {basemap.archives.map((archive) => (
            <li key={archive.name}>
              <span>
                <strong>{archive.name}</strong>
                <span className="note">{formatBytes(archive.bytes)}</span>
              </span>
              <button
                type="button"
                disabled={busy || basemap.active?.name === archive.name}
                onClick={() => void basemap.show(archive.name)}
              >
                {basemap.active?.name === archive.name ? 'In use' : 'Use this'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {basemap.active && (
        <p className="meta">
          {basemap.active.name} covers zoom {basemap.active.minZoom} to {basemap.active.maxZoom}.
          Beyond that the map keeps zooming by scaling the deepest tiles it has.
        </p>
      )}
    </section>
  )
}
