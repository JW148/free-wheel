import { useCallback, useEffect, useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import { sharedEngine } from '../engine/engineClient'
import { REGIONS, estimateRegion, formatBytes, tilesForBbox, type TileCatalogue } from '../engine/tiles'
import type { ImportProgress, InstalledTile } from '../engine/tileStore'

/** Where the user downloads road data from by hand. The app never fetches this itself. */
const BROUTER_SEGMENTS = 'https://brouter.de/brouter/segments4/'

/**
 * Setting a phone up from files, for when the mirror cannot be reached.
 *
 * Folded behind a disclosure, and both halves of it in one place, because it is *one* task —
 * "I have the files, put them on the phone" — that used to be two panels sitting at the same
 * level as the thing 99% of riders want. A region download is the way in; this is the bucket
 * outage, the custom `pmtiles extract`, and the area the published list does not cover.
 *
 * Open by default only when the screen above it has nothing else to offer: a phone that has
 * never reached the mirror has no region list to act on, and an apology with a collapsed
 * disclosure under it is a dead end with a lid on.
 *
 * The app still never fetches from brouter.de itself, here or anywhere else: it sends no CORS
 * header, so a browser could not do it directly even if we wanted to. Download-only use of
 * `segments4/` is the respectful pattern, and the cost of this path is staleness, which the
 * region list above surfaces rather than hides.
 */
export default function ManualImport({
  basemap,
  regionIds = [],
  open = false,
}: {
  basemap: ReturnType<typeof useMapLibre>
  /** Regions this phone has downloaded, whose archives this panel must not offer to delete. */
  regionIds?: string[]
  open?: boolean
}) {
  const [showing, setShowing] = useState(open)
  const [catalogue, setCatalogue] = useState<TileCatalogue | null>(null)
  const [regionId, setRegionId] = useState(REGIONS[0].id)
  const [installed, setInstalled] = useState<InstalledTile[]>([])
  const [progress, setProgress] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await sharedEngine().installedTiles())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Nothing is fetched until the disclosure is opened. The catalogue is a network request that
  // every rider on the happy path would otherwise pay for and never read.
  useEffect(() => {
    if (!showing) return
    void refreshInstalled()
    if (catalogue) return
    fetch(new URL('engine/tile-catalogue.json', document.baseURI))
      .then((response) => {
        if (!response.ok) throw new Error(`no tile catalogue (${response.status})`)
        return response.json() as Promise<TileCatalogue>
      })
      .then(setCatalogue)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [showing, catalogue, refreshInstalled])

  const region = REGIONS.find((r) => r.id === regionId)!
  const selection = catalogue ? estimateRegion(catalogue, tilesForBbox(region.bbox)) : null

  const importRoadData = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setError(null)
    try {
      const result = await sharedEngine().importTiles(files, (p: ImportProgress) =>
        setProgress(`${p.tile}: ${formatBytes(p.received)} of ${formatBytes(p.total)}`),
      )
      if (result.failed.length) setError(result.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))
      await refreshInstalled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const importMaps = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setError(null)
    try {
      const result = await sharedEngine().importBasemaps(files, (p: ImportProgress) =>
        setProgress(`${p.tile}: ${formatBytes(p.received)} of ${formatBytes(p.total)}`),
      )
      if (result.failed.length) setError(result.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))
      // Every installed archive is drawn, so an imported one needs no "use this" — syncing is
      // the whole of putting it on screen, and it joins whatever is already there.
      await basemap.sync({ focus: result.imported[0] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const removeArchive = async (name: string) => {
    setBusy(true)
    setError(null)
    try {
      await sharedEngine().deleteBasemap(name)
      // Takes its layers and source off the live map as well as the file off the disk.
      await basemap.sync()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!showing) {
    return (
      <button type="button" className="picker-plain maps-manual-toggle" onClick={() => setShowing(true)}>
        Set up from files instead
      </button>
    )
  }

  return (
    <section className="maps-manual">
      <h3 className="subhead">From files</h3>
      <p className="sub">
        For a mirror outage, or an area the region list does not cover. Road data comes as
        5°×5° tiles named by their south-west corner; a map is a PMTiles archive you build with{' '}
        <code>pmtiles extract</code>.
      </p>

      {error && <p className="error">{error}</p>}
      {progress && <p className="meta">{progress}</p>}

      <div className="actions">
        <label className="filebutton" data-disabled={busy ? 'yes' : 'no'}>
          Import maps…
          <input
            type="file"
            accept=".pmtiles"
            multiple
            disabled={busy}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = '' // let the same file be re-picked after a failure
              void importMaps(files)
            }}
          />
        </label>
        <label className="filebutton" data-disabled={busy ? 'yes' : 'no'}>
          Import road data…
          <input
            type="file"
            accept=".rd5"
            multiple
            disabled={busy}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              void importRoadData(files)
            }}
          />
        </label>
      </div>

      {/* The archives this panel created. Without this list a hand-imported map is drawn on the
          screen and named nowhere — the region library above only knows about downloads, so
          there was no way to see what had been imported, or to take it back off. */}
      <h3 className="subhead">Maps in storage</h3>
      {basemap.archives.length === 0 ? (
        <p className="setup-empty">No maps yet — imported or downloaded.</p>
      ) : (
        <ul className="maps-list">
          {basemap.archives.map((archive) => {
            const owned = regionIds.includes(archive.name.replace(/\.pmtiles$/i, ''))
            return (
              <li key={archive.name} className="maps-row">
                <div className="maps-row-main">
                  <span className="picker-name">{archive.name}</span>
                  <span className="maps-row-note">
                    {formatBytes(archive.bytes)}
                    {owned && ' · part of a downloaded region'}
                  </span>
                </div>
                <div className="maps-row-actions">
                  <button type="button" onClick={() => void basemap.flyToArchive(archive.name)}>
                    Show me
                  </button>
                  {/* A region's archive is removed by removing the region, which also drops the
                      record and any road data nothing else wants. Deleting the file on its own
                      would leave a record claiming bytes that are gone. */}
                  {!owned && (
                    <button
                      type="button"
                      className="maps-remove"
                      disabled={busy}
                      onClick={() => void removeArchive(archive.name)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <h3 className="subhead">Which road data an area needs</h3>
      <div className="actions">
        <select value={regionId} onChange={(e) => setRegionId(e.target.value)} disabled={busy}>
          {REGIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {selection && (
        <>
          <p className="meta">
            {region.note} · <strong>{selection.tiles.length} tiles</strong>,{' '}
            {formatBytes(selection.bytes)} to download
          </p>
          <table>
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
                    <td>{have ? 'imported' : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      <h3 className="subhead">
        Road data in storage — {installed.length} tiles, {formatBytes(installed.reduce((sum, t) => sum + t.bytes, 0))}
      </h3>
      {installed.length === 0 ? (
        <p className="setup-empty">No road data yet.</p>
      ) : (
        <table>
          <tbody>
            {installed.map((tile) => (
              <tr key={tile.tile}>
                <td>
                  <code>{tile.tile}</code>
                </td>
                <td>{formatBytes(tile.bytes)}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await sharedEngine().deleteTile(tile.tile)
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

      <p className="meta">
        Deleting road data a region still claims leaves that region unable to route. The region
        list above will show it as needing an update.
      </p>

      <button type="button" className="picker-plain" onClick={() => setShowing(false)}>
        Hide
      </button>
    </section>
  )
}
