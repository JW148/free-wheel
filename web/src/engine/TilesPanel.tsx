import { useCallback, useEffect, useMemo, useState } from 'react'
import { REGIONS, estimateRegion, formatBytes, tilesForBbox, type TileCatalogue } from './tiles'
import { sharedEngine } from './engineClient'
import type { ImportProgress, InstalledTile } from './tileStore'

/** Where the user downloads segments from. The app never fetches this itself — see below. */
const BROUTER_SEGMENTS = 'https://brouter.de/brouter/segments4/'

/**
 * Regions and tiles — the manual escape hatch.
 *
 * The region picker (`RegionPicker.tsx`) downloading from our mirror is the app's primary way
 * onto a phone now. This panel is what is left for the cases the mirror can't cover: a bucket
 * outage, or a custom extract the region list doesn't carry. It works out which tiles a region
 * needs, says how big they are, links to them on brouter.de, and imports what the user fetches.
 *
 * The app still never fetches from brouter.de itself, here or anywhere else: it sends no CORS
 * header, so a browser could not fetch from it directly regardless of whether we wanted to. The
 * cost of this manual path is staleness, which the UI surfaces rather than hides.
 */
export default function TilesPanel() {
  const [catalogue, setCatalogue] = useState<TileCatalogue | null>(null)
  const [regionId, setRegionId] = useState(REGIONS[0].id)
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({})
  const [installed, setInstalled] = useState<InstalledTile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [routeOut, setRouteOut] = useState<string | null>(null)

  // Module-level and stable, so it is safe to reference from hooks.
  const engine = sharedEngine

  useEffect(() => {
    fetch(new URL('engine/tile-catalogue.json', document.baseURI))
      .then((r) => {
        if (!r.ok) throw new Error(`no tile catalogue (${r.status}) — npm run build-catalogue`)
        return r.json() as Promise<TileCatalogue>
      })
      .then(setCatalogue)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await engine().installedTiles())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [engine])

  useEffect(() => {
    void refreshInstalled()
  }, [refreshInstalled])

  const region = REGIONS.find((r) => r.id === regionId)!
  const selection = useMemo(
    () => (catalogue ? estimateRegion(catalogue, tilesForBbox(region.bbox)) : null),
    [catalogue, region],
  )

  const importFiles = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setError(null)
    setProgress({})
    try {
      const result = await engine().importTiles(files, (p) =>
        setProgress((prev) => ({ ...prev, [p.tile]: p })),
      )
      if (result.failed.length) {
        setError(result.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))
      }
      await refreshInstalled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const testRoute = async () => {
    setBusy(true)
    setRouteOut(null)
    try {
      const outcome = await engine().route('trekking', '-0.1278,51.5074|-0.0754,51.5155')
      setRouteOut(
        outcome.ok
          ? `ok — ${outcome.gpxLength} bytes, crc ${outcome.gpxCrc32}, ${outcome.ms} ms`
          : `error — ${outcome.error}`,
      )
    } catch (e) {
      setRouteOut(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const installedBytes = installed.reduce((sum, t) => sum + t.bytes, 0)

  return (
    <section>
      <h2>Regions and tiles</h2>
      <p className="sub">
        Routing data comes as 5°×5° tiles named by their south-west corner. Pick a region to see
        which you need, download them from brouter.de, then import them here — the app never
        downloads them for you.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <select value={regionId} onChange={(e) => setRegionId(e.target.value)} disabled={busy}>
          {REGIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <label className="filebutton">
          Import .rd5 files…
          <input
            type="file"
            multiple
            accept=".rd5"
            disabled={busy}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = '' // let the same file be re-picked after a failure
              void importFiles(files)
            }}
          />
        </label>
        <button disabled={busy} onClick={testRoute}>
          Test route
        </button>
      </div>

      {selection && (
        <>
          <p className="meta">
            {region.note} · <strong>{selection.tiles.length} tiles</strong>,{' '}
            {formatBytes(selection.bytes)} to download
          </p>
          <table>
            <thead>
              <tr>
                <th>tile</th>
                <th>size</th>
                <th>rebuilt</th>
                <th aria-label="status" />
              </tr>
            </thead>
            <tbody>
              {selection.tiles.map((tile) => {
                const entry = catalogue?.tiles[tile]
                const have = installed.find((i) => i.tile === tile)
                return (
                  <tr key={tile}>
                    <td>
                      <a href={`${BROUTER_SEGMENTS}${tile}.rd5`} rel="noreferrer noopener">
                        {tile}.rd5
                      </a>
                    </td>
                    <td>{entry ? formatBytes(entry.bytes) : '—'}</td>
                    <td className="note">{entry?.modified ?? '—'}</td>
                    <td>{have ? '✅ imported' : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {routeOut && <p className="meta">route: {routeOut}</p>}

      {Object.keys(progress).length > 0 && (
        <table>
          <tbody>
            {Object.values(progress).map((p) => (
              <tr key={p.tile} className={p.state === 'failed' ? 'fail' : undefined}>
                <td>
                  <code>{p.tile}</code>
                </td>
                <td>
                  {p.state}
                  {p.detail ? ` — ${p.detail}` : ''}
                </td>
                <td>
                  {formatBytes(p.received)}
                  {p.total > 0 && ` / ${formatBytes(p.total)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="subhead">
        In storage — {installed.length} tiles, {formatBytes(installedBytes)}
      </h3>
      <div className="actions">
          <button
            disabled={busy || installed.length === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await engine().resetTileStorage()
                await refreshInstalled()
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Remove all tiles
          </button>
      </div>
      {installed.length === 0 ? (
        <p className="meta">no tiles in storage yet</p>
      ) : (
        <table>
          <tbody>
            {installed.map((t) => (
              <tr key={t.tile}>
                <td>
                  <code>{t.tile}</code>
                  <StaleNote installed={t} catalogue={catalogue} />
                </td>
                <td>{formatBytes(t.bytes)}</td>
                <td>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await engine().deleteTile(t.tile)
                        await refreshInstalled()
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * Says how old an imported tile is.
 *
 * A manually imported file carries no hash to compare against upstream, unlike a mirror
 * download — it is a snapshot that will not update itself, so the app should be candid about
 * its age rather than let a rider discover a year-old road layout on the road. brouter.de
 * rebuilds weekly, so anything beyond a few weeks is worth re-importing.
 */
function StaleNote({
  installed,
  catalogue,
}: {
  installed: InstalledTile
  catalogue: TileCatalogue | null
}) {
  const entry = catalogue?.tiles[installed.tile]
  const sizeDiffers = entry !== undefined && entry.bytes !== installed.bytes

  // No import date means the file predates the manifest, or arrived some other way. Say so
  // rather than inventing an age — an unknown provenance is itself worth re-importing over.
  const days =
    installed.importedAt === null
      ? null
      : Math.floor((Date.now() - installed.importedAt) / 86_400_000)

  const age =
    days === null
      ? 'present in storage, import date unknown'
      : days === 0
        ? 'imported today'
        : `imported ${days} day${days === 1 ? '' : 's'} ago`

  const hint = sizeDiffers
    ? ' · brouter.de now publishes a different size — worth re-importing'
    : days !== null && days >= 28
      ? ' · brouter.de rebuilds weekly; consider re-importing'
      : days === null
        ? ' · re-import to be sure of what it contains'
        : ''

  return <span className="note">{age + hint}</span>
}
