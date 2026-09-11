import { useCallback, useEffect, useMemo, useState } from 'react'
import type { useMapLibre } from '../ride/useMapLibre'
import { loadManifest, type DataManifest, type InstalledRegion } from '../data/manifest'
import { assetUrl } from '../data/origin'
import { sharedEngine } from '../engine/engineClient'
import ManualImport from './ManualImport'
import BrowseMap from './BrowseMap'
import { downloads, useDownloads } from './downloadStore'
import { jobLine, jobPercent } from './downloadQueue'
import {
  freedBy,
  installedOn,
  regionsAt,
  removalPrice,
  storageLine,
  storageTotal,
  updatable,
  withNearestFirst,
} from './libraryModel'
import {
  failureCopy,
  formatMegabytes,
  pickerFailure,
  statesOf,
  summarise,
  tidyMessage,
  type CatalogueFailure,
  type RegionSummary,
} from './pickerModel'
import type { PaintedState } from './regionLayers'

/**
 * Everything to do with the maps on this phone: what is here, and how to get more.
 *
 * ## One screen, two modes
 *
 * **Library** is the list of regions this phone holds — size, age, whether an update is
 * waiting, and how to remove one. **Browse** is the map of Britain you tap to add more. They
 * are the same screen because they are the same subject, and because the alternative is what
 * this replaced: a first-run gate that downloaded exactly one region, exited to the ride view
 * the moment it finished, and could never be reached again for the life of the install. The
 * only way to a second region was a manual file import.
 *
 * ## Downloads do not belong to this screen
 *
 * Tapping a region hands a job to `downloadStore`, which is a module singleton. Closing this
 * screen, going back to the ride view, or starting a ride does not stop it — so a rider can
 * queue four regions and put the phone in a pocket. The rows here are a *view* of that queue,
 * which is why they survive being unmounted and why the same progress can be shown anywhere
 * else that asks.
 *
 * ## Nothing here is a dead end
 *
 * The two failures this screen can hit — no list of regions, no reachable storage — both get
 * their own words, and both keep the manual import below reachable. A phone that has never
 * seen the mirror must still be able to be set up from files.
 */
export default function MapsScreen({
  basemap,
  onInstalledChange,
}: {
  basemap: ReturnType<typeof useMapLibre>
  /** Told whenever the number of installed regions changes, so the gate above can open. */
  onInstalledChange?: (count: number) => void
}) {
  const [catalogue, setCatalogue] = useState<Catalogue>({ phase: 'loading' })
  const [mode, setMode] = useState<Mode>('library')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The region whose row is expanded in the library, which is where Remove lives. */
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [here, setHere] = useState<string[]>([])
  const [locating, setLocating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const jobs = useDownloads()
  const { sync, flyToArchive, theme } = basemap

  const summaries = useMemo(
    () =>
      catalogue.phase === 'ready'
        ? summarise(catalogue.manifest, catalogue.installed, catalogue.fresh)
        : [],
    [catalogue],
  )

  // The list, and what this phone already holds.
  //
  // Fetched together but settled apart, because the two fail for completely different reasons
  // and the screen has to name the right one — `pickerFailure` decides which. `allSettled`
  // keeps the network request and the Worker's start-up in parallel; they are the two slowest
  // things on a first launch.
  const load = useCallback(async () => {
    const [list, storage] = await Promise.allSettled([
      loadManifest(),
      sharedEngine().installedRegions(),
    ])
    const failure = pickerFailure(list, storage)
    if (failure) return setCatalogue({ phase: 'unavailable', ...failure })
    if (list.status === 'fulfilled' && storage.status === 'fulfilled') {
      setCatalogue({
        phase: 'ready',
        manifest: list.value.manifest,
        fresh: list.value.fresh,
        installed: storage.value,
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A region landing changes three things at once: the records this screen reads, the archives
  // the map draws, and whether the gate above may open. Driven from the store rather than from
  // a download call, because the download that finishes very often was not started on this
  // screen — or while it was even mounted.
  useEffect(
    () =>
      downloads.onInstalled((records) => {
        setCatalogue((current) =>
          current.phase === 'ready' ? { ...current, installed: records } : current,
        )
      }),
    [],
  )

  const installedCount = catalogue.phase === 'ready' ? catalogue.installed.length : 0
  useEffect(() => {
    onInstalledChange?.(installedCount)
  }, [installedCount, onInstalledChange])

  const start = useCallback(
    (summary: RegionSummary) => {
      if (catalogue.phase !== 'ready') return
      downloads.start(summary.region, catalogue.manifest, summary.bytes)
      // Deselected rather than dismissed: the next tap should be able to land on the next
      // region straight away. Queueing four regions is the thing this screen exists to make
      // possible, so it must not cost four round trips through a detail sheet.
      setSelectedId(null)
    },
    [catalogue],
  )

  const remove = useCallback(
    async (id: string) => {
      setRemoving(id)
      setNotice(null)
      try {
        const records = await sharedEngine().removeRegion(id)
        setCatalogue((current) => (current.phase === 'ready' ? { ...current, installed: records } : current))
        setOpenRow(null)
        // Takes the archive's layers and source off the live map. Without it the map keeps a
        // source pointed at a file that no longer exists, and MapLibre reports a missing tile
        // as nothing at all — so the region would look like one that had failed to download.
        await sync()
      } catch (error) {
        setNotice(`That region could not be removed: ${tidyMessage(error)}.`)
      } finally {
        setRemoving(null)
      }
    },
    [sync],
  )

  /**
   * Asks for a fix once, on a tap.
   *
   * On a tap and nowhere else. A permission prompt that appears because a screen was opened is
   * the kind a rider dismisses on reflex, and this screen works perfectly well without one —
   * the map is right there to point at. What it buys is the common case: you are standing in
   * the region you want and would rather not hunt for its name.
   */
  const locate = useCallback(() => {
    if (catalogue.phase !== 'ready') return
    setLocating(true)
    setNotice(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const regions = regionsAt(catalogue.manifest.regions, coords.longitude, coords.latitude)
        setLocating(false)
        setHere(regions)
        if (regions.length === 0) {
          setNotice('You are outside every region on offer, so nothing has moved to the top.')
        } else if (regions.length === 1) {
          setSelectedId(regions[0])
        }
      },
      () => {
        setLocating(false)
        setNotice('free-wheel could not get a location. Pick your area on the map instead.')
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    )
  }, [catalogue])

  const installed = catalogue.phase === 'ready' ? catalogue.installed : []
  const manifest = catalogue.phase === 'ready' ? catalogue.manifest : null
  const mine = summaries.filter((summary) => summary.state !== 'not-installed')
  const updates = updatable(mine)

  // What the outlines paint from: the real region state, overridden by a live download. A
  // region being fetched is neither installed nor merely available, and saying it is either
  // would have a rider tap it again.
  const painted = useMemo((): Record<string, PaintedState> => {
    const states: Record<string, PaintedState> = statesOf(summaries)
    for (const job of jobs) {
      if (job.state === 'queued' || job.state === 'downloading') states[job.id] = 'downloading'
    }
    return states
  }, [summaries, jobs])

  const selected = summaries.find((summary) => summary.id === selectedId) ?? null
  const jobFor = (id: string) => jobs.find((job) => job.id === id) ?? null

  if (catalogue.phase === 'loading') {
    return (
      <section className="maps">
        <p className="picker-note" role="status">
          Fetching the list of regions…
        </p>
      </section>
    )
  }

  if (catalogue.phase === 'unavailable') {
    const copy = failureCopy(catalogue.cause)
    return (
      <section className="maps">
        <h2>{copy.heading}</h2>
        <p className="picker-note">{copy.explanation}</p>
        <p className="picker-detail">{catalogue.reason}</p>
        <button type="button" className="maps-retry" onClick={() => void load()}>
          Try again
        </button>
        {/* The way through. A phone that has never reached the mirror has nothing else on this
            screen it can act on, and an apology with no exit is the dead end this replaced. */}
        <ManualImport basemap={basemap} open />
      </section>
    )
  }

  if (mode === 'browse') {
    const ordered = withNearestFirst(summaries, here)
    return (
      <div className="browse">
        {/* Above the map and always visible. The way back used to be the last row of a
            scrolling sheet, which on a phone meant scrolling past fourteen regions to leave. */}
        <div className="browse-bar">
          <button type="button" className="browse-back" onClick={() => setMode('library')}>
            ‹ Maps
          </button>
          <span className="browse-title">Add a region</span>
        </div>

        <BrowseMap
          archiveUrl={assetUrl(catalogue.manifest.picker.url)}
          theme={theme}
          regions={catalogue.manifest.regions}
          states={painted}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <div className="browse-sheet">
          {selected === null ? (
            <>
              <div className="browse-sheet-head">
                <p className="picker-note">Tap your area on the map, or choose it below.</p>
                <button type="button" className="browse-locate" onClick={locate} disabled={locating}>
                  {locating ? 'Locating…' : 'Use my location'}
                </button>
              </div>
              {notice && <p className="picker-detail">{notice}</p>}
              <ul className="picker-list">
                {ordered.map((summary) => {
                  const job = jobFor(summary.id)
                  return (
                    <li key={summary.id}>
                      <button type="button" onClick={() => setSelectedId(summary.id)}>
                        <span className="picker-name">
                          {summary.name}
                          {here.includes(summary.id) && <span className="maps-chip">Where you are</span>}
                        </span>
                        <span className="picker-size">
                          {job
                            ? jobLine(job)
                            : summary.bytes > 0
                              ? summary.size
                              : summary.state === 'not-installed'
                                ? 'Nothing to fetch'
                                : 'Already here'}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <>
              <button type="button" className="picker-plain" onClick={() => setSelectedId(null)}>
                ← All regions
              </button>
              <h2>{selected.name}</h2>
              {selected.status && <p className="picker-note">{selected.status}</p>}
              {jobFor(selected.id) ? (
                <>
                  <p className="picker-note" role="status">
                    {jobLine(jobFor(selected.id)!)}
                  </p>
                  <button
                    type="button"
                    className="picker-plain"
                    onClick={() => downloads.cancel(selected.id)}
                  >
                    Stop this download
                  </button>
                </>
              ) : (
                <>
                  <p className="picker-size">{selected.price}</p>
                  <button
                    type="button"
                    className="primary"
                    disabled={selected.bytes === 0}
                    onClick={() => start(selected)}
                  >
                    {selected.bytes === 0 ? 'Already on this phone' : selected.action}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="maps">
      {!catalogue.fresh && (
        <p className="picker-note maps-stale">
          This list was saved the last time you were online, so the sizes below may have changed
          since.
        </p>
      )}

      <button type="button" className="maps-add" onClick={() => setMode('browse')}>
        <span className="maps-add-plus" aria-hidden="true">
          +
        </span>
        <span>
          <strong>Add a region</strong>
          <span className="note">Pick an area of Britain and download its map and road data.</span>
        </span>
      </button>

      {jobs.length > 0 && (
        <>
          <h3 className="subhead">Downloading</h3>
          <ul className="maps-list">
            {jobs.map((job) => (
              <li key={job.id} className="maps-row">
                <div className="maps-row-main">
                  <span className="picker-name">{job.name}</span>
                  <span className="maps-row-note">{jobLine(job)}</span>
                </div>
                {job.state === 'failed' ? (
                  <div className="maps-row-actions">
                    <button type="button" onClick={() => downloads.retry(job.id)}>
                      Retry
                    </button>
                    <button type="button" className="picker-plain" onClick={() => downloads.dismiss(job.id)}>
                      Dismiss
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="picker-plain"
                    onClick={() => downloads.cancel(job.id)}
                  >
                    Stop
                  </button>
                )}
                {job.state !== 'failed' && (
                  <div
                    className="picker-bar maps-row-bar"
                    role="progressbar"
                    aria-valuenow={jobPercent(job)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Downloading ${job.name}`}
                  >
                    <span style={{ width: `${jobPercent(job)}%` }} />
                  </div>
                )}
                {job.failure?.advice && <p className="maps-row-advice">{job.failure.advice}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="subhead">On this phone</h3>
      {notice && <p className="picker-detail">{notice}</p>}

      {mine.length === 0 ? (
        <p className="picker-note">Nothing downloaded yet.</p>
      ) : (
        <ul className="maps-list">
          {mine.map((summary) => {
            const record = installed.find((r) => r.id === summary.id)
            const expanded = openRow === summary.id
            const freed = manifest ? freedBy(manifest, installed, summary.id) : 0
            return (
              <li key={summary.id} className="maps-row">
                <button
                  type="button"
                  className="maps-row-main maps-row-button"
                  aria-expanded={expanded}
                  onClick={() => setOpenRow(expanded ? null : summary.id)}
                >
                  <span className="picker-name">{summary.name}</span>
                  <span className="maps-row-note">
                    {summary.state === 'current'
                      ? `Up to date · added ${installedOn(record)}`
                      : summary.state === 'unknown'
                        ? `Added ${installedOn(record)} · cannot check for updates offline`
                        : summary.bytes > 0
                          ? `Update available · ${summary.size}`
                          : 'Up to date'}
                  </span>
                </button>

                {expanded && (
                  <div className="maps-row-detail">
                    {summary.bytes > 0 && summary.state !== 'not-installed' && (
                      <button type="button" className="primary" onClick={() => start(summary)}>
                        Update ({summary.size})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void flyToArchive(`${summary.id}.pmtiles`)}
                    >
                      Show me on the map
                    </button>
                    <p className="maps-row-advice">{removalPrice(freed)}</p>
                    <button
                      type="button"
                      className="maps-remove"
                      disabled={removing === summary.id}
                      onClick={() => void remove(summary.id)}
                    >
                      {removing === summary.id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {updates.length > 1 && (
        <button
          type="button"
          className="maps-update-all"
          onClick={() => updates.forEach(start)}
        >
          Update all {updates.length} ({formatMegabytes(updates.reduce((sum, s) => sum + s.bytes, 0))})
        </button>
      )}

      {manifest && installed.length > 0 && (
        <p className="meta maps-storage">
          {storageLine(installed.length, storageTotal(manifest, installed))}
        </p>
      )}

      <ManualImport basemap={basemap} regionIds={installed.map((record) => record.id)} />
    </section>
  )
}

type Mode = 'library' | 'browse'

/**
 * Three states, and `loading` is one of them rather than a null manifest with a flag beside it:
 * the screen has something different to say in each, and a shape that cannot express "loaded
 * but empty" is a shape that cannot render a spinner forever.
 */
type Catalogue =
  | { phase: 'loading' }
  | { phase: 'ready'; manifest: DataManifest; fresh: boolean; installed: InstalledRegion[] }
  | ({ phase: 'unavailable' } & CatalogueFailure)
