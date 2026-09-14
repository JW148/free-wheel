import { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer } from 'vaul'
import type { useMapLibre } from '../ride/useMapLibre'
import {
  loadManifest,
  type DataManifest,
  type InstalledRegion,
  type RegionEntry,
} from '../data/manifest'
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
import { regionSwatch, type PaintedState } from './regionLayers'

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
 * ## Browse is a map, and the map is the control
 *
 * The regions are painted *into* Britain rather than boxed on top of it — see
 * `regionShapes.ts`. That changes what the screen has to be: the list stops being the way in
 * and becomes the way to find a name you already know, so it lives in the same drawer the ride
 * screen uses and starts closed. What is left on screen is a bar with three things in it — the
 * way back, what is chosen, and the one action worth taking — over a full-height map.
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
  /** The region drawer, which starts closed so that the map is the first thing a rider meets. */
  const [listOpen, setListOpen] = useState(false)
  /** Set only when the choice came from the list; see `BrowseMap`'s `frame` prop. */
  const [frame, setFrame] = useState<{ region: RegionEntry } | null>(null)
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

  /**
   * Which region the rider is standing in, **without asking**.
   *
   * The rule this screen already states — never prompt for location because a screen was
   * opened — is right, and this does not break it: the permission is only *read*, and a fix is
   * only requested where it has already been granted. In practice it usually has been, because
   * the first run's last card asks for it by name.
   *
   * Where it has not, the section simply is not drawn. Guessing a region from nothing would be
   * a confident claim about where somebody lives, and the list below is already the answer.
   */
  useEffect(() => {
    if (catalogue.phase !== 'ready') return
    let cancelled = false
    const regions = catalogue.manifest.regions
    void (async () => {
      try {
        const status = await navigator.permissions?.query({
          name: 'geolocation' as PermissionName,
        })
        if (status?.state !== 'granted' || cancelled) return
        navigator.geolocation.getCurrentPosition(
          ({ coords }) => {
            if (!cancelled) setHere(regionsAt(regions, coords.longitude, coords.latitude))
          },
          () => {},
          // A five-minute-old fix is fine for "which region is this" — it is a question about
          // a 200 km box, and waiting for a fresh one costs battery for no extra accuracy.
          { enableHighAccuracy: false, maximumAge: 300_000, timeout: 8000 },
        )
      } catch {
        // No Permissions API for geolocation. Silently do without: the list is the fallback.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [catalogue])

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
      // The selection *stays*. It used to be cleared so the next tap could land on the next
      // region without a trip back out of a detail sheet — but the sheet is gone, the map is
      // the whole screen, and the next tap lands wherever it likes whether or not something is
      // selected. What clearing cost was the one thing worth showing: the bar is where this
      // download's progress is, and dropping the selection dropped it.
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
          return
        }
        // One region covering the fix is an answer, not a shortlist: choose it, show it, and
        // get the list out of the way. Several means the rider is in an overlap and still has
        // a decision, so the list stays up with those regions at the top.
        const only = regions.length === 1 ? catalogue.manifest.regions.find((r) => r.id === regions[0]) : null
        if (only) {
          setSelectedId(only.id)
          setFrame({ region: only })
          setListOpen(false)
        }
      },
      () => {
        setLocating(false)
        setNotice('free-wheel could not get a location. Pick your area on the map instead.')
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    )
  }, [catalogue])

  /**
   * Chosen by name, which is the one case where the map has to move.
   *
   * The list and the map are two ways into the same decision, and a name is worth nothing until
   * a rider can see where it is — so this frames the region and closes the drawer over it. A tap
   * on the map itself goes straight to `setSelectedId`, because the ground must not shift under
   * the finger that just landed on it.
   */
  const chooseFromList = useCallback((summary: RegionSummary) => {
    setSelectedId(summary.id)
    setFrame({ region: summary.region })
    setListOpen(false)
  }, [])

  const openBrowse = useCallback(() => {
    setSelectedId(null)
    setFrame(null)
    setListOpen(false)
    setNotice(null)
    setMode('browse')
  }, [])

  const leaveBrowse = useCallback(() => {
    setSelectedId(null)
    setFrame(null)
    setListOpen(false)
    setMode('library')
  }, [])

  const installed = catalogue.phase === 'ready' ? catalogue.installed : []
  const manifest = catalogue.phase === 'ready' ? catalogue.manifest : null
  const mine = summaries.filter((summary) => summary.state !== 'not-installed')
  /*
   * The regions covering the rider's fix, minus the ones there is nothing to say about.
   * A region already downloaded and current is not news, and a job already running has its own
   * row above with a progress bar on it.
   */
  const hereSummaries = summaries.filter(
    (summary) =>
      here.includes(summary.id) &&
      summary.bytes > 0 &&
      summary.state !== 'current' &&
      !jobs.some((job) => job.id === summary.id),
  )
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
    const job = selected ? jobFor(selected.id) : null
    return (
      <div className="browse">
        <BrowseMap
          archiveUrl={assetUrl(catalogue.manifest.picker.url)}
          theme={theme}
          regions={catalogue.manifest.regions}
          states={painted}
          selectedId={selectedId}
          onSelect={setSelectedId}
          frame={frame}
          padding={BROWSE_PADDING}
        />

        {/*
          The whole of the chrome, and the only thing over the map.

          There used to be a bar at the top holding nothing but the way back, and a sheet at the
          bottom deep enough to bury England. The back button is a single control and belongs
          beside the other two rather than on a strip of its own — and the list it used to sit
          above is now a drawer, so the map has the screen.

          Three slots, always in the same places: out, what is chosen, and the one thing to do
          about it. The middle is the way into the list, which is what makes the drawer
          discoverable without it having to be open.
        */}
        <div className="browse-bar">
          <button
            type="button"
            className="browse-back"
            onClick={leaveBrowse}
            aria-label="Back to the maps on this phone"
          >
            <ChevronLeftIcon />
          </button>

          {/* A download fills the row that names it, left to right, rather than pushing a bar
              out underneath the chrome. The bar's three slots are fixed and its height has to be
              a constant — a fourth thing appearing every time a download starts moved the
              buttons out from under the rider's thumb, which is what this replaced. The fill is
              decorative: the line under the name already says how far along it is in words, and
              that is what a screen reader reads. */}
          <button
            type="button"
            className="sheet-toggle"
            data-filling={job && job.state !== 'failed' ? 'yes' : 'no'}
            onClick={() => setListOpen(true)}
          >
            {job && job.state !== 'failed' && (
              <span
                className="sheet-fill"
                style={{ width: `${jobPercent(job)}%` }}
                aria-hidden="true"
              />
            )}
            <span className="sheet-profile">
              {selected ? (
                <>
                  <span
                    className="swatch"
                    style={{ background: regionSwatch(painted[selected.id] ?? 'not-installed') }}
                  />
                  {selected.name}
                </>
              ) : (
                'Add a region'
              )}
            </span>
            <span className="sheet-count">
              {job
                ? jobLine(job)
                : selected
                  ? selected.line
                  : 'Tap an area, or browse the list'}
            </span>
          </button>

          {job && job.state !== 'failed' ? (
            <button type="button" className="primary busy" onClick={() => downloads.cancel(job.id)}>
              Stop
            </button>
          ) : job ? (
            <button type="button" className="primary" onClick={() => downloads.retry(job.id)}>
              Retry
            </button>
          ) : selected ? (
            <button
              type="button"
              className="primary"
              disabled={selected.bytes === 0}
              onClick={() => start(selected)}
            >
              {selected.bytes === 0 ? 'Got it' : selected.action}
            </button>
          ) : (
            // Nothing is chosen, so there is nothing to download and the useful offer is the
            // one shortcut past choosing at all. It is an icon because it is the third control
            // on a 390px bar, and it disappears the moment a region is selected — one primary
            // action at a time, and by then the decision is already made.
            <button
              type="button"
              className="browse-locate"
              onClick={locate}
              disabled={locating}
              aria-label="Use my location"
            >
              {locating ? <span className="browse-locating" /> : <LocateIcon />}
            </button>
          )}
        </div>

        {/*
          The same drawer the ride screen uses, for the same reason: swipe to dismiss done
          properly is velocity tracking, rubber-banding, scroll disambiguation and focus
          trapping, and vaul already does all of it. It portals to `<body>`, so it is not
          subject to this screen's layout at all — which is what lets the map keep the full
          height underneath it.
        */}
        <Drawer.Root open={listOpen} onOpenChange={setListOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="drawer-overlay" />
            <Drawer.Content className="drawer" aria-describedby={undefined}>
              <Drawer.Handle className="drawer-handle" />
              <div className="drawer-body">
                <div className="drawer-head">
                  <Drawer.Title className="drawer-title">Regions</Drawer.Title>
                  <button type="button" onClick={locate} disabled={locating}>
                    {locating ? 'Locating…' : 'Use my location'}
                  </button>
                </div>

                {notice && <p className="picker-detail">{notice}</p>}

                <ul className="picker-list">
                  {ordered.map((summary) => {
                    const rowJob = jobFor(summary.id)
                    return (
                      <li key={summary.id}>
                        <button
                          type="button"
                          data-selected={summary.id === selectedId ? 'yes' : 'no'}
                          onClick={() => chooseFromList(summary)}
                        >
                          <span className="picker-name">
                            <span
                              className="swatch"
                              style={{
                                background: regionSwatch(painted[summary.id] ?? 'not-installed'),
                              }}
                            />
                            {summary.name}
                            {here.includes(summary.id) && (
                              <span className="maps-chip">Where you are</span>
                            )}
                          </span>
                          <span className="picker-size">
                            {rowJob
                              ? jobLine(rowJob)
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
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
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

      {/*
        The region you are standing in, offered first.

        The commonest thing a rider wants from this screen is the area they are in, and hunting
        for its name in a list of fourteen is a worse way to get it than being handed it. Drawn
        only when a fix is already available — see the effect above — and only where it says
        something the list does not: a region already downloaded and up to date needs no card.
      */}
      {hereSummaries.length > 0 && (
        <>
          <h3 className="subhead">Where you are</h3>
          <ul className="maps-list">
            {hereSummaries.map((summary) => (
              <li key={summary.id} className="maps-row maps-row-here">
                <div className="maps-row-main">
                  <span className="picker-name">
                    <span
                      className="swatch"
                      style={{ background: regionSwatch(painted[summary.id] ?? 'not-installed') }}
                    />
                    {summary.name}
                  </span>
                  <span className="maps-row-note">
                    {summary.state === 'not-installed'
                      ? `${summary.size} · map and road data`
                      : `${summary.size} · road data has an update`}
                  </span>
                </div>
                <button type="button" className="primary" onClick={() => start(summary)}>
                  {summary.state === 'not-installed' ? 'Download' : 'Update'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <button type="button" className="maps-add" onClick={openBrowse}>
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
        <p className="setup-empty">Nothing downloaded yet.</p>
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

/**
 * What the bar over the browse map covers, in CSS pixels, so `fitBounds` frames the part of the
 * map a rider can actually see.
 *
 * Measured against the bar rather than guessed at: three rows of controls at `min-height: 3rem`
 * plus its margins and the home indicator. It is generous at the top for the attribution
 * control, which is a licence requirement and must not sit over the Highlands.
 */
const BROWSE_PADDING = { top: 64, bottom: 128 }

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

/** A crosshair, which is what every map on this phone already uses for "where am I". */
function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="5.5" />
      <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
    </svg>
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
