import { useCallback, useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { mountBasemap, registerPmtilesProtocol, sourceStats } from './opfsPmtiles'
import { checkMapLibreWorker, configureMapLibreWorker } from './maplibreWorker'
import { basemapStyle } from './style'
import { sharedEngine } from '../engine/engineClient'
import type { ImportProgress } from '../engine/tileStore'

// Both at module scope, before any Map can be constructed. `addProtocol` is global to the
// maplibre module rather than per-instance, and a Map built first cannot resolve the scheme.
// The worker URL is read when the pool is first created, so it has the same constraint —
// and getting it wrong is silent. See `maplibreWorker.ts`.
registerPmtilesProtocol()
const workerUrl = configureMapLibreWorker()

const formatBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`

/**
 * The offline basemap: a PMTiles archive read out of OPFS, with no network involved.
 *
 * Labels are absent by design at this stage — see `style.ts`.
 */
export default function MapPanel() {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<MapLibreMap | null>(null)

  const [archives, setArchives] = useState<{ name: string; bytes: number }[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rendered, setRendered] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [reads, setReads] = useState<string | null>(null)
  const [worker, setWorker] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setArchives(await sharedEngine().installedBasemaps())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // A dead worker is invisible from the map's own events, so ask directly rather than
    // waiting for a render that never comes.
    void checkMapLibreWorker().then((problem) =>
      setWorker(problem ? `worker BROKEN — ${problem}` : `worker ok: ${workerUrl}`),
    )
  }, [refresh])

  const show = useCallback(async (name: string) => {
    setError(null)
    setBusy(true)
    try {
      const header = await mountBasemap(name)
      setInfo(
        `${name} · ${formatBytes(header.bytes)} · zoom ${header.minZoom}–${header.maxZoom} · ` +
          `bounds ${header.bounds.map((n) => n.toFixed(2)).join(', ')}`,
      )

      map.current?.remove()
      map.current = new MapLibreMap({
        container: container.current!,
        style: basemapStyle(name),
        center: header.center,
        zoom: 12,
        maxZoom: header.maxZoom,
        // Nothing to fetch from a network, so failures should be loud rather than retried.
        attributionControl: { compact: true },
      })
      // Trace the load lifecycle. "A canvas exists" says nothing about whether tiles
      // decoded, and a stall is indistinguishable from an empty archive without this.
      const seen: string[] = []
      const note = (what: string) => {
        if (seen.includes(what)) return
        seen.push(what)
        setStage(seen.join(' → '))
      }
      map.current.on('error', (e) => {
        note('error')
        setError(e.error?.message ?? 'map error')
      })
      map.current.on('load', () => note('load'))
      map.current.on('sourcedata', (e) => {
        if (e.sourceId === 'basemap' && e.isSourceLoaded) note('source loaded')
      })
      map.current.on('dataloading', () => note('dataloading'))

      // Poll the source counters: if reads stop climbing while the map never idles, the
      // stall is downstream of OPFS rather than in it.
      const poll = setInterval(() => {
        setReads(
          `OPFS reads ${sourceStats.reads}, ${formatBytes(sourceStats.bytes)}` +
            (sourceStats.lastError ? ` · last error: ${sourceStats.lastError}` : '') +
            ` · protocol: ${sourceStats.requests.slice(0, 6).join(' ; ') || 'none'}`,
        )
      }, 500)
      map.current.once('remove', () => clearInterval(poll))

      // Count what actually rendered once the map settles. A canvas and a clean error log
      // prove nothing on their own — an archive that failed to decode looks identical to an
      // empty one. A feature count is the difference between "a map" and "a grey rectangle".
      map.current.on('idle', () => {
        const features = map.current?.queryRenderedFeatures() ?? []
        const byLayer = new Map<string, number>()
        for (const f of features) byLayer.set(f.layer.id, (byLayer.get(f.layer.id) ?? 0) + 1)
        setRendered(
          features.length === 0
            ? 'no features rendered — the archive decoded but covers nothing here'
            : `${features.length} features: ` +
                [...byLayer].map(([id, n]) => `${id} ${n}`).join(', '),
        )
      })
      // Debug hook: lets the map's internal state be inspected from the console while the
      // offline pipeline is still being brought up. Remove once the basemap is settled.
      ;(window as unknown as { __map?: MapLibreMap; __MapLibre?: unknown; __style?: unknown }).__map =
        map.current
      ;(window as unknown as { __MapLibre?: unknown }).__MapLibre = MapLibreMap
      ;(window as unknown as { __style?: unknown }).__style = basemapStyle
      setActive(name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => () => map.current?.remove(), [])

  return (
    <section>
      <h2>Offline basemap</h2>
      <p className="sub">
        A PMTiles archive read straight out of OPFS by byte range — no tile server, no network.
        Build one with <code>pmtiles extract</code> and import it here. Labels are not rendered
        yet: glyphs are a separate piece of work.
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
              e.target.value = ''
              if (!files.length) return
              setBusy(true)
              setError(null)
              try {
                const result = await sharedEngine().importBasemaps(files, (p: ImportProgress) =>
                  setInfo(`${p.tile}: ${formatBytes(p.received)} / ${formatBytes(p.total)}`),
                )
                if (result.failed.length) {
                  setError(result.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))
                }
                await refresh()
                if (result.imported[0]) await show(result.imported[0])
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          />
        </label>
        {archives.map((a) => (
          <button key={a.name} disabled={busy || active === a.name} onClick={() => show(a.name)}>
            {a.name} ({formatBytes(a.bytes)})
          </button>
        ))}
      </div>

      {worker && <p className={worker.includes('BROKEN') ? 'error' : 'meta'}>{worker}</p>}
      {info && <p className="meta">{info}</p>}
      {stage && <p className="meta">stages: {stage}</p>}
      {reads && <p className="meta">{reads}</p>}
      {rendered && <p className="meta">{rendered}</p>}

      <div
        ref={container}
        className="map"
        // Height must be explicit: MapLibre measures its container, and a zero-height
        // container renders nothing with no error.
        style={{ height: '60vh', minHeight: 320 }}
      />
    </section>
  )
}
