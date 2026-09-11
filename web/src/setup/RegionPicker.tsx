import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapMouseEvent } from 'maplibre-gl'
import type { useMapLibre } from '../ride/useMapLibre'
import { loadManifest, type DataManifest, type InstalledRegion } from '../data/manifest'
import { assetUrl } from '../data/origin'
import { sharedEngine } from '../engine/engineClient'
import type { RegionProgress } from '../engine/downloads'
import {
  REGION_FILL_LAYER,
  REGION_SOURCE,
  ensureRegionLayers,
  regionsGeoJson,
  removeRegionLayers,
  setRegionData,
} from './regionLayers'
import {
  downloadFailure,
  downloadStatus,
  failureCopy,
  handbackCopy,
  MAP_WOULD_NOT_OPEN,
  mayStandDown,
  pickerFailure,
  sheetPrice,
  statesOf,
  summarise,
  tidyMessage,
  type CatalogueFailure,
  type RegionSummary,
} from './pickerModel'

/**
 * Pick where you ride, and get everything you need for it in one download.
 *
 * This replaces a screen that asked a rider to build an archive with a command-line tool and
 * to work out which 5° grid square their ride fell in. Both were knowable — neither was
 * guessable, and nobody arriving at the app fresh had any reason to try. So the screen is a
 * map of Britain with the regions drawn on it: tap yours, read the size, press the button
 * once.
 *
 * ## The words
 *
 * A rider is downloading **the map** and **the road data**. The file formats, the grid the
 * road data is cut on and the storage it lands in never appear — not in the copy, and not in
 * the errors either, which is the harder half: the download layer throws with the URL it was
 * fetching in the message. Every failure goes through `pickerModel.downloadFailure`, which is
 * where that gets taken back out, and where the copy is under test.
 *
 * The size is stated plainly and it is stated *before* the button. Safari implements no
 * `NetworkInformation`, so there is no honest way to know whether a rider is on wifi or on a
 * 200 MB-a-month plan — and hedging ("this may use a lot of data") would be inventing a
 * warning we cannot substantiate. Say the number; let them decide.
 *
 * ## What happens when it does not work
 *
 * Four states, and none of them is a blank screen or a spinner that never resolves:
 *
 * - **Offline with a saved list.** `loadManifest` reports `fresh: false`, which goes straight
 *   through to `regionState`, which reports `unknown` rather than guessing `current`. The
 *   screen says so.
 * - **Offline having never seen the list.** `loadManifest` throws. The screen says that
 *   plainly and offers the way it used to work — importing files by hand, in Setup — and a
 *   way past it entirely, because a rider must never be able to get stuck behind this screen.
 *   A phone that then gets set up by hand stands the picker down by itself: `App.tsx` asks
 *   storage again when Setup closes.
 * - **Storage unreachable.** Its own headline, not the offline one. `navigator.storage` is
 *   `undefined` rather than merely restricted on a plain-http origin — a condition this
 *   project's own LAN device testing walks into — and telling that rider to check their
 *   internet sends them looking in the wrong place entirely.
 * - **A failed download.** The sheet stays open, holding the error and a Retry. The retry
 *   resumes: the partial bytes and the marker describing them are already recorded and the
 *   engine recomputes from them on every attempt, so there is deliberately no retry
 *   bookkeeping here.
 * - **No room left.** Surfaced as itself, with the one piece of advice that actually helps.
 *   Nothing is pre-sized against `navigator.storage.estimate()`: that number is deliberately
 *   fuzzed, so checking it up front would refuse downloads that would have worked.
 */
export default function RegionPicker({
  basemap,
  standDown,
  onDone,
  onOpenSetup,
}: {
  basemap: ReturnType<typeof useMapLibre>
  /**
   * Setup has closed and this phone is ready to ride, so the picker should hand the map back
   * and stand down.
   *
   * A request rather than a gate flipped over this screen's head, and that is the whole
   * point: the handback is the borrower's job, it can fail, and only the borrower is on
   * screen to say so. `App` asking here is what stops there being two implementations of the
   * same exit — which is how the ordering went wrong the last three times.
   */
  standDown: boolean
  onDone: () => void
  /**
   * The way through to manual import. Not optional: a phone that has never reached the
   * mirror has nothing else on this screen it can act on, and an apology with no exit is
   * the dead end this screen exists to remove.
   */
  onOpenSetup: () => void
}) {
  const [catalogue, setCatalogue] = useState<Catalogue>({ phase: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RegionProgress | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  /** Whether the handback is in flight, so the sheet can say so and offer nothing to tap. */
  const [standingDown, setStandingDown] = useState(false)
  /** Whether it came back unfinished, which is a state this screen has to hold and explain. */
  const [handbackFailed, setHandbackFailed] = useState(false)
  /**
   * The same flag as `standingDown`, as a ref, because that is the one that actually guards:
   * a second tap arrives long before React has re-rendered the first one's disabled button,
   * and two handbacks over one container is two `show()`s racing to build a map in it.
   */
  const standingDownRef = useRef(false)
  /**
   * Latched the moment this screen starts leaving, and never cleared.
   *
   * It says the picker is done with the map: no backdrop may be mounted after it — a streamed
   * Britain arriving over the map the rider was just given back is the fault this whole round
   * is about, and a retry after a failed handback must not bring one back either — and the
   * unmount cleanup below has nothing left to hand over.
   */
  const mapReleased = useRef(false)

  // The hook returns a fresh object every render, so effects depend on the callbacks — which
  // are stable — rather than on `basemap` itself.
  const { map, styleReady, showRemote, show, endRemote, refresh, error: mapError } = basemap

  const summaries = useMemo(
    () =>
      catalogue.phase === 'ready'
        ? summarise(catalogue.manifest, catalogue.installed, catalogue.fresh)
        : [],
    [catalogue],
  )
  const selected = summaries.find((s) => s.id === selectedId) ?? null

  // The list, and what this phone already holds.
  //
  // Both or neither: a phone whose engine cannot read its own records must not be offered a
  // download, because the download would compute its plan from those same records and
  // re-fetch what is already here.
  //
  // Fetched together but settled apart, because the two fail for completely different reasons
  // and the screen has to name the right one. `allSettled` keeps the network request and the
  // Worker's start-up in parallel — they are the two slowest things on a first launch — while
  // `pickerFailure` decides which fault to report.
  useEffect(() => {
    let live = true
    void (async () => {
      const [list, storage] = await Promise.allSettled([
        loadManifest(),
        sharedEngine().installedRegions(),
      ])
      if (!live) return
      const failure = pickerFailure(list, storage)
      if (failure) {
        setCatalogue({ phase: 'unavailable', ...failure })
      } else if (list.status === 'fulfilled' && storage.status === 'fulfilled') {
        setCatalogue({
          phase: 'ready',
          manifest: list.value.manifest,
          fresh: list.value.fresh,
          installed: storage.value,
        })
      }
    })()
    return () => {
      live = false
    }
  }, [])

  // Britain, streamed over HTTP range straight from the mirror, so there is something to read
  // a region off before anything has been downloaded. Guarded by a ref rather than by the
  // effect's dependencies: rebuilding the map would throw away the region layers below it.
  const backdrop = catalogue.phase === 'ready' ? assetUrl(catalogue.manifest.picker.url) : null
  const shownBackdrop = useRef<string | null>(null)
  useEffect(() => {
    if (!backdrop || mapReleased.current || shownBackdrop.current === backdrop) return
    shownBackdrop.current = backdrop
    void showRemote(backdrop)
  }, [backdrop, showRemote])

  // Outlines on top of it. `ensureRegionLayers` is idempotent, and has to be: `styleReady`
  // flips again whenever the style reloads, and the layers go with it.
  //
  // Not once a download has started, though. A finished download replaces the backdrop with
  // the region's own archive, and that rebuild flips `styleReady` one last time — on a map
  // that is about to become the ride screen, where region boxes drawn across it would be
  // somebody else's furniture.
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || running || summaries.length === 0) return
    ensureRegionLayers(instance)
    setRegionData(
      instance,
      regionsGeoJson(
        summaries.map((s) => s.region),
        statesOf(summaries),
      ),
    )
  }, [map, styleReady, running, summaries])

  /**
   * Leaving the picker, in the one order that works — and only if the map came back.
   *
   * Two things have to be true before the gate opens, and each of them cost a round of fixes:
   *
   * **The handback has to finish first.** A cleanup cannot await, and React runs an unmounting
   * child's cleanups before the updated tree's effects in the same passive phase — so a
   * handback started from a cleanup is still suspended at its first `await` when `RideView`'s
   * newly unsuspended effects run, against a `styleReady` that is still true and a
   * `map.current` that is still the streamed archive. Not a race: those closures captured
   * `styleReady === true` already, so it happened every time. It cost two silent faults — pins
   * created on an instance about to be detached and never re-added to the real one, and
   * `lastFitted` written for the streamed map so the restored map's `fitBounds` was skipped.
   *
   * **And it has to have worked.** `endRemote` reads storage, and storage is exactly what
   * fails when a second copy of the app is open — the one collision this repo says the app can
   * do nothing about except handle. It answers with which of three things the rider is now
   * looking at, and two of them are somewhere they can be left. The third is not: the map is
   * down, nobody has been told why, and the remedy is something only this screen can ask for.
   * So the picker holds, says so, and offers a retry that is a real retry.
   */
  const leave = useCallback(async () => {
    if (standingDownRef.current) return
    standingDownRef.current = true
    mapReleased.current = true
    setStandingDown(true)
    setHandbackFailed(false)
    try {
      const outcome = await endRemote()
      if (!mayStandDown(outcome)) {
        setHandbackFailed(true)
        return
      }
      onDone()
    } catch {
      // `endRemote` reports rather than throws, and if that ever stops being true the rule is
      // the same: do not open the gate onto a handback nobody can vouch for.
      setHandbackFailed(true)
    } finally {
      standingDownRef.current = false
      setStandingDown(false)
    }
  }, [endRemote, onDone])

  /**
   * Setup has closed and the phone is ready, so stand down — through the same exit as every
   * other one, rather than having the gate flipped from outside while the map is still lent.
   */
  useEffect(() => {
    if (standDown) void leave()
  }, [standDown, leave])

  // The outlines come off with the screen: the map outlives the picker — one controller, two
  // screens — so leaving them on paints region boxes across the ride screen.
  //
  // `endRemote` is here only as a safety net, for an exit that bypasses `leave` entirely, and
  // only while there is still a loan `leave` has not dealt with. It is a no-op on every
  // ordinary path. Do not make this the mechanism again — see `leave` above for what that
  // cost, and note that it cannot be awaited, so anything it starts finishes after the ride
  // screen's effects have already run.
  useEffect(
    () => () => {
      const instance = map.current
      if (instance) removeRegionLayers(instance)
      if (shownBackdrop.current !== null && !mapReleased.current) void endRemote()
    },
    [map, endRemote],
  )

  // A tap on a region selects it. Ignored mid-download: the sheet is the only thing on screen
  // reporting progress, and a stray tap on the map must not close it.
  const runningRef = useRef(running)
  useEffect(() => {
    runningRef.current = running
  }, [running])
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady) return
    const onClick = (event: MapMouseEvent) => {
      if (runningRef.current) return
      if (!instance.getLayer(REGION_FILL_LAYER)) return
      const [feature] = instance.queryRenderedFeatures(event.point, { layers: [REGION_FILL_LAYER] })
      const id = feature?.properties?.id
      setSelectedId(typeof id === 'string' ? id : null)
    }
    instance.on('click', onClick)
    return () => {
      instance.off('click', onClick)
    }
  }, [map, styleReady])

  // Which outline is thick. Set on every region rather than only on the two that changed, so
  // a style reload — which drops feature state along with the layers — re-establishes all of
  // it without needing to remember what the previous selection was.
  useEffect(() => {
    const instance = map.current
    if (!instance || !styleReady || !instance.getSource(REGION_SOURCE)) return
    for (const summary of summaries) {
      instance.setFeatureState(
        { source: REGION_SOURCE, id: summary.id },
        { selected: summary.id === selectedId },
      )
    }
  }, [map, styleReady, summaries, selectedId])

  const start = useCallback(
    async (summary: RegionSummary, manifest: DataManifest) => {
      setRunning(true)
      setFailure(null)
      setProgress(null)
      try {
        await sharedEngine().downloadRegion(summary.region, manifest, setProgress)
        // The screen let go of the map while this was running — Setup is reachable from the
        // head throughout — so the region is recorded and kept, but mounting it now would be
        // this screen redrawing a map it no longer owns.
        if (mapReleased.current) return
        // The archive list is read from storage, not remembered, so it has to be re-read
        // before the map can be pointed at a name that only just appeared in it.
        await refresh()
        // The name `regionStore.basemapFileFor` writes it under. Kept as a literal rather than
        // imported, because importing it would pull the whole Worker-side storage module onto
        // the main thread for one string.
        if (!(await show(`${summary.region.id}.pmtiles`))) {
          // The bytes are down and the region is recorded; what failed was opening it, which
          // is a different sentence and a different decision. Leaving here would slide the
          // rider onto whatever *other* archive is installed with no explanation at all, so
          // the screen holds the fault and the Retry costs nothing — the engine recomputes
          // from disk and finds everything already present.
          setFailure(MAP_WOULD_NOT_OPEN)
          setRunning(false)
          return
        }
        // One way out of this screen rather than two. `show` has closed the loan, so the
        // handback is a no-op here.
        await leave()
      } catch (error) {
        // Deliberately no bookkeeping of what got through: the engine recomputes that from
        // disk on every attempt, and a second opinion held here could only ever disagree.
        setFailure(error)
        setRunning(false)
      }
    },
    [leave, refresh, show],
  )

  const handback = handbackCopy()
  const status = downloadStatus(progress)
  const problem = failure === null ? null : downloadFailure(failure)
  const price = selected === null ? null : sheetPrice(selected.price, problem !== null)

  return (
    <div className="picker">
      <div className="picker-head">
        <h1>Where do you ride?</h1>
        <p>
          free-wheel plans and follows routes with the network off, so the map and the road
          data have to be on the phone. Pick a region and it fetches both, once.
        </p>
        {catalogue.phase === 'ready' && !catalogue.fresh && (
          <p className="picker-note">
            This list was saved the last time you were online, so the sizes below may have
            changed since.
          </p>
        )}
        {/* The secondary route out. Hidden when the list could not be fetched at all, because
            the sheet is offering the same thing as its primary action down there. */}
        {catalogue.phase !== 'unavailable' && (
          <button type="button" className="picker-plain" onClick={onOpenSetup}>
            Set up by hand instead
          </button>
        )}
      </div>

      <div className="picker-sheet">
        {/* Three layers, in this order for a reason. The handback is what the rider is
            waiting on, so it speaks over everything; a handback that failed is the only thing
            on this screen that is still true, because the map behind it is gone and "tap your
            area" would be an instruction nobody can follow. */}
        {standingDown ? (
          <p className="picker-note" role="status">
            Opening your map…
          </p>
        ) : handbackFailed ? (
          <>
            <h2>{handback.heading}</h2>
            <p className="picker-note">{handback.explanation}</p>
            {mapError && <p className="picker-detail">{tidyMessage(mapError)}</p>}
            <button type="button" className="primary" onClick={() => void leave()}>
              {handback.retry}
            </button>
            {/* Not a dead end, even here. The map is already down, so this lands on a ride
                screen that reports the same fault rather than on a borrowed one pretending to
                be theirs. */}
            <button type="button" className="picker-plain" onClick={onDone}>
              {handback.carryOn}
            </button>
          </>
        ) : (
          <>
            {catalogue.phase === 'loading' && (
              <p className="picker-note" role="status">
                Fetching the list of regions…
              </p>
            )}

            {catalogue.phase === 'unavailable' && (
              <>
                <h2>{failureCopy(catalogue.cause).heading}</h2>
                <p className="picker-note">{failureCopy(catalogue.cause).explanation}</p>
                <p className="picker-detail">{catalogue.reason}</p>
                <button type="button" className="primary" onClick={onOpenSetup}>
                  {failureCopy(catalogue.cause).action}
                </button>
                {/* The way out, and the reason it is spelled out rather than implied: a phone
                    set up by hand stands the picker down by itself when Setup closes, but a
                    rider who wants to look at the app first should not have to find that out by
                    guessing. */}
                <button type="button" className="picker-plain" onClick={() => void leave()}>
                  Carry on without a region
                </button>
              </>
            )}

            {catalogue.phase === 'ready' && selected === null && (
              <>
                <p className="picker-note">
                  {summaries.length > 0
                    ? 'Tap your area on the map, or choose it here.'
                    : 'There are no regions on offer yet. Set the phone up by hand for now.'}
                </p>
                <ul className="picker-list">
                  {summaries.map((summary) => (
                    <li key={summary.id}>
                      <button type="button" onClick={() => setSelectedId(summary.id)}>
                        <span className="picker-name">{summary.name}</span>
                        <span className="picker-size">
                          {summary.bytes > 0 ? summary.size : 'Already here'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {catalogue.phase === 'ready' && selected !== null && (
              <>
                {!running && (
                  <button
                    type="button"
                    className="picker-plain"
                    onClick={() => setSelectedId(null)}
                  >
                    ← All regions
                  </button>
                )}
                <h2>{selected.name}</h2>
                {selected.status && <p className="picker-note">{selected.status}</p>}

                {running ? (
                  <>
                    {/* The size stays on screen while it downloads: it is the number that tells a
                        rider how long to expect to wait. */}
                    <p className="picker-size">{selected.size} in total</p>
                    <div
                      className="picker-bar"
                      role="progressbar"
                      aria-valuenow={status.percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`Downloading ${selected.name}`}
                    >
                      <span style={{ width: `${status.percent}%` }} />
                    </div>
                    <p className="picker-note" role="status">
                      {status.line}
                    </p>
                  </>
                ) : (
                  <>
                    {/* Suppressed after a failure: the mount-time price is for the whole region,
                        and the retry will resume. `sheetPrice` holds the rule and the reason, and
                        what it hands back is what renders. */}
                    {price !== null && <p className="picker-size">{price}</p>}
                    {problem && (
                      <div className="picker-problem" role="alert">
                        <p>{problem.message}</p>
                        {problem.advice && <p className="picker-note">{problem.advice}</p>}
                      </div>
                    )}
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void start(selected, catalogue.manifest)}
                    >
                      {problem ? 'Retry' : selected.action}
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Three states, and `loading` is one of them rather than a null manifest with a flag beside
 * it: the screen has something different to say in each, and a shape that cannot express
 * "loaded but empty" is a shape that cannot render a spinner forever.
 */
type Catalogue =
  | { phase: 'loading' }
  | { phase: 'ready'; manifest: DataManifest; fresh: boolean; installed: InstalledRegion[] }
  | ({ phase: 'unavailable' } & CatalogueFailure)
