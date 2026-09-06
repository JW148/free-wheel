import { useCallback, useEffect, useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import { sharedEngine } from '../engine/engineClient'
import { formatBytes, tileName } from '../engine/tiles'
import type { ImportProgress } from '../engine/tileStore'

/**
 * Getting the two files onto the phone, in order, with nothing to work out.
 *
 * The app is useless until a basemap and a routing tile are both in OPFS, and neither can be
 * downloaded for you — the tiles are import-only by design, and `brouter.de` sends no CORS
 * header so a browser could not fetch from it even if we wanted to.
 *
 * What *can* be removed is the guesswork. The step that used to be hardest was knowing which
 * `.rd5` you needed: BRouter names segments by their south-west corner on a 5° grid, which is
 * not something anyone should have to compute. Once the basemap is in, its centre tells us
 * the answer, so step two names the exact file and links straight to it.
 */
export default function FirstRun({
  basemap,
  onDone,
}: {
  basemap: ReturnType<typeof useMapLibre>
  onDone: () => void
}) {
  const [tiles, setTiles] = useState<string[]>([])
  const [busy, setBusy] = useState<null | 'basemap' | 'tiles'>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshTiles = useCallback(async () => {
    try {
      setTiles((await sharedEngine().installedTiles()).map((t) => t.tile))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refreshTiles()
  }, [refreshTiles])

  const haveBasemap = basemap.archives.length > 0
  const haveTiles = tiles.length > 0

  // The segment covering the middle of whatever map was imported. Only the endpoints of a
  // route really matter, but the basemap's centre is a good enough guess to name the file,
  // and a wrong guess costs a download rather than a wrong route.
  const suggested = basemap.active
    ? tileName(basemap.active.center[0], basemap.active.center[1])
    : null

  const importFiles = async (kind: 'basemap' | 'tiles', files: File[]) => {
    setBusy(kind)
    setError(null)
    try {
      const engine = sharedEngine()
      const onProgress = (p: ImportProgress) =>
        setProgress(`${p.tile} — ${formatBytes(p.received)} of ${formatBytes(p.total)}`)
      const result =
        kind === 'basemap'
          ? await engine.importBasemaps(files, onProgress)
          : await engine.importTiles(files, onProgress)

      if (result.failed.length) {
        setError(result.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))
      }
      if (kind === 'basemap') {
        await basemap.refresh()
        if (result.imported[0]) await basemap.show(result.imported[0])
      } else {
        await refreshTiles()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  return (
    <div className="firstrun">
      <div className="firstrun-inner">
        <h1>Two files and you are riding</h1>
        <p className="firstrun-lede">
          free-wheel does all its routing on the phone, so the map and the road data have to
          live here too. You import them once; after that it works in airplane mode.
        </p>

        <ol className="steps">
          <li data-done={haveBasemap ? 'yes' : 'no'}>
            <span className="step-index" aria-hidden="true">
              {haveBasemap ? '✓' : '1'}
            </span>
            <div>
              <h2>The map you look at</h2>
              {haveBasemap ? (
                <p className="step-note">
                  {basemap.active?.name ?? basemap.archives[0].name} —{' '}
                  {formatBytes(basemap.active?.bytes ?? basemap.archives[0].bytes)}
                </p>
              ) : (
                <p className="step-note">
                  A <code>.pmtiles</code> archive covering where you ride. Build one with{' '}
                  <code>pmtiles extract</code> on a computer, then AirDrop it over.
                </p>
              )}
              <label className="filebutton">
                {haveBasemap ? 'Import another' : 'Import .pmtiles'}
                <input
                  type="file"
                  accept=".pmtiles"
                  multiple
                  disabled={busy !== null}
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])]
                    e.target.value = ''
                    if (files.length) void importFiles('basemap', files)
                  }}
                />
              </label>
            </div>
          </li>

          <li data-done={haveTiles ? 'yes' : 'no'} data-blocked={haveBasemap ? 'no' : 'yes'}>
            <span className="step-index" aria-hidden="true">
              {haveTiles ? '✓' : '2'}
            </span>
            <div>
              <h2>The road data it routes on</h2>
              {haveTiles ? (
                <p className="step-note">
                  {tiles.map((t) => `${t}.rd5`).join(', ')} installed.
                </p>
              ) : suggested ? (
                <p className="step-note">
                  For this map you need <strong>{suggested}.rd5</strong>. Download it, save it
                  to Files, then import it here.
                  <br />
                  <a
                    href={`https://brouter.de/brouter/segments4/${suggested}.rd5`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    brouter.de/brouter/segments4/{suggested}.rd5
                  </a>
                </p>
              ) : (
                <p className="step-note">
                  Import a map first and this step will tell you exactly which file to fetch.
                </p>
              )}
              <label className="filebutton" data-disabled={haveBasemap ? 'no' : 'yes'}>
                {haveTiles ? 'Import another' : 'Import .rd5'}
                <input
                  type="file"
                  accept=".rd5"
                  multiple
                  disabled={busy !== null || !haveBasemap}
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])]
                    e.target.value = ''
                    if (files.length) void importFiles('tiles', files)
                  }}
                />
              </label>
            </div>
          </li>
        </ol>

        {progress && (
          <p className="firstrun-progress" role="status">
            {progress}
          </p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="firstrun-actions">
          <button
            type="button"
            className="primary"
            disabled={!haveBasemap || busy !== null}
            onClick={onDone}
          >
            {haveTiles ? 'Start riding' : 'Continue without routing'}
          </button>
          {haveBasemap && !haveTiles && (
            <p className="step-note">
              Without road data you can look at the map, but nothing can be routed.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
