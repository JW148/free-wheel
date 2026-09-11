import { useCallback, useEffect, useRef, useState } from 'react'
import { AttributionControl, Map as MapLibreMap } from 'maplibre-gl'
import { mountBasemap, mountRemoteBasemap, registerPmtilesProtocol } from '../map/opfsPmtiles'
import { checkMapLibreWorker, configureMapLibreWorker } from '../map/maplibreWorker'
import { basemapStyle, pathFilter, type MapTheme, type PathMode } from '../map/style'
import { handbackPlan, type Handback } from '../map/archiveChoice'
import { sharedEngine } from '../engine/engineClient'
import { ensureRouteLayers } from './routeLayers'

/** Re-exported so a caller of {@link useMapLibre} does not have to know where it lives. */
export type { Handback }

// Both at module scope, before any Map can exist. `addProtocol` is global to the maplibre
// module rather than per-instance, and the worker URL is read when the pool is first
// created — a Map constructed before either is set up fails silently. This cost Phase 3;
// see `maplibreWorker.ts` and CLAUDE.md.
registerPmtilesProtocol()
export const workerUrl = configureMapLibreWorker()

/** Remembered so the app opens on the archive you were last using, not an arbitrary one. */
const LAST_BASEMAP_KEY = 'free-wheel.basemap.v1'
const THEME_KEY = 'free-wheel.theme.v1'
const PATHS_KEY = 'free-wheel.paths.v1'

function storedTheme(): MapTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** The archive last opened, or null if there is none or storage is unreadable. */
function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_BASEMAP_KEY)
  } catch {
    // Private mode. Whatever is installed is as good a default as any.
    return null
  }
}

function storedPathMode(): PathMode {
  try {
    const stored = localStorage.getItem(PATHS_KEY)
    return stored === 'all' || stored === 'none' ? stored : 'rideable'
  } catch {
    return 'rideable'
  }
}

export interface BasemapInfo {
  name: string
  bytes: number
  minZoom: number
  maxZoom: number
  center: [number, number]
}

type Status = 'loading' | 'no-basemap' | 'ready' | 'error'

/**
 * Owns the MapLibre instance and the OPFS-backed archive behind it.
 *
 * The map is created once per archive and torn down when the archive changes — MapLibre has
 * no supported way to swap a source's underlying protocol handle, and rebuilding is cheap
 * next to the alternative of reasoning about half-migrated tile caches.
 */
export function useMapLibre(container: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<MapLibreMap | null>(null)
  const [archives, setArchives] = useState<{ name: string; bytes: number }[]>([])
  const [active, setActive] = useState<BasemapInfo | null>(null)
  const activeRef = useRef<BasemapInfo | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [workerProblem, setWorkerProblem] = useState<string | null>(null)
  /** Flipped once the style has loaded, so callers know it is safe to touch layers. */
  const [styleReady, setStyleReady] = useState(false)
  const [theme, setThemeState] = useState<MapTheme>(storedTheme)
  // `show` needs the current theme but must not be rebuilt when it changes, or every theme
  // switch would tear the map down and remount the archive.
  const themeRef = useRef(theme)
  themeRef.current = theme
  /**
   * The streamed archive on screen, if any, and the local one it displaced.
   *
   * `showRemote` is a *loan* of the map, not a handover. It skips `ensureRouteLayers` and
   * never touches `active`, on the assumption that a `show()` always follows it — true of the
   * region picker's download path and nothing else. A rider who reached the picker with a
   * basemap but no road data, took the manual route, imported only the road data and pressed
   * Done was left on a network-streamed Britain at zoom 4.6: no route source, so a planned
   * line drew nothing; no position source, so the dot never appeared; `activeRef` null, so the
   * theme button did nothing. Every one of those fails silently. {@link endRemote} is what
   * closes the loan.
   */
  const remoteRef = useRef<string | null>(null)
  const displacedRef = useRef<string | null>(null)
  /**
   * Bumped every time the map is given back, so a loan still in flight knows it was cancelled.
   *
   * `showRemote` suspends at the archive header, which on a slow mirror is seconds — long
   * enough for a rider to take the manual route, import their files and press Done. Without
   * this the header lands afterwards and drops a streamed Britain over the map they were just
   * given back, with no loan recorded to undo it.
   */
  const loanGeneration = useRef(0)
  // `endRemote` has to know what the map is doing without being rebuilt when it changes.
  const statusRef = useRef(status)
  statusRef.current = status
  const [pathMode, setPathModeState] = useState<PathMode>(storedPathMode)
  // Same reasoning as `themeRef`: `show` needs the current value without being rebuilt when it
  // changes, or every path toggle would tear the map down and remount the archive.
  const pathModeRef = useRef(pathMode)
  pathModeRef.current = pathMode

  // A dead MapLibre worker produces no error event and no failed request — the map simply
  // never draws. Asking directly is the only cheap way to tell that apart from an empty
  // archive, so the check stays in the shipping app rather than only in diagnostics.
  useEffect(() => {
    void checkMapLibreWorker().then(setWorkerProblem)
  }, [])

  /**
   * Mounts a local archive, and reports whether it made it onto the screen.
   *
   * The boolean is for {@link endRemote}, which has to know: a failed `show` leaves whatever
   * was already up still up, and during a loan that is the *streamed* archive. Treating a
   * silent failure here as a finished handback is how a rider ends up on a map of Britain
   * that looks like theirs and is not. Every other caller is welcome to ignore it — the
   * error is on `error` and the status is `error` either way.
   */
  const show = useCallback(
    async (name: string): Promise<boolean> => {
      setError(null)
      setStyleReady(false)
      try {
        const header = await mountBasemap(name)

        map.current?.remove()
        const created = new MapLibreMap({
          container: container.current!,
          style: basemapStyle(name, themeRef.current, pathModeRef.current),
          center: header.center,
          zoom: 12,
          // Past the archive's own max zoom, not at it: MapLibre overzooms vector tiles by
          // scaling the deepest tile it has, so capping here would put street-level detail
          // permanently out of reach on a map whose whole job is street-level detail.
          maxZoom: Math.min(header.maxZoom + 5, 19),
          // Added by hand below so it can go bottom-*left*. The default corner is
          // bottom-right, which is where the control column and the action bar both live.
          attributionControl: false,
          // A rotated map is disorienting on a bike and easy to trigger by accident with a
          // gloved two-finger touch. Pitch likewise buys nothing here.
          pitchWithRotate: false,
          dragRotate: false,
        })
        created.touchZoomRotate.disableRotation()
        created.addControl(new AttributionControl({ compact: true }), 'bottom-left')

        created.on('error', (e) => setError(e.error?.message ?? 'map error'))
        created.once('load', () => {
          ensureRouteLayers(created)
          setStyleReady(true)
        })

        map.current = created
        const info: BasemapInfo = {
          name,
          bytes: header.bytes,
          minZoom: header.minZoom,
          maxZoom: header.maxZoom,
          center: header.center,
        }
        activeRef.current = info
        setActive(info)
        // A local archive is up, so there is no loan outstanding. This is what makes
        // `endRemote` a no-op after a finished download, and after a hand-imported basemap.
        remoteRef.current = null
        setStatus('ready')
        try {
          localStorage.setItem(LAST_BASEMAP_KEY, name)
        } catch {
          // Not remembering the archive is a small annoyance, not a failure.
        }
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return false
      }
    },
    [container],
  )

  /**
   * Shows a remote archive streamed over HTTP range, for the region picker.
   *
   * Follows `show` except in four ways: it mounts the archive by URL instead of an OPFS
   * name, it opens on Britain rather than the archive's own centre, it never touches
   * `archives` or `active` — a streamed archive is not installed, and the ride screen must
   * never be able to mistake this backdrop for a downloaded region — and its `load` handler
   * skips `ensureRouteLayers`. The picker draws no route, and `show()` rebuilds the map with
   * those layers anyway when a real region is mounted, so adding the call here would be
   * dead code, not a fix — do not "restore" it.
   *
   * The ~25 lines of map construction below are a near-duplicate of `show`'s. Left
   * duplicated rather than factored out for now: nothing in this repo tests `useMapLibre`
   * (it needs a DOM and a live MapLibre instance), and this file's failure mode is the one
   * that cost the project a whole phase — a broken map produces no error and no failed
   * request, it simply never draws. An untested refactor of map construction is the wrong
   * trade today; factoring the shared construction into a helper is recorded as a follow-up.
   */
  const showRemote = useCallback(
    async (url: string) => {
      setError(null)
      setStyleReady(false)
      // Only on the first loan: a second `showRemote` would otherwise record the *streamed*
      // archive as the thing to go back to, which is nothing at all.
      if (remoteRef.current === null) displacedRef.current = activeRef.current?.name ?? null
      const generation = (loanGeneration.current += 1)
      try {
        const header = await mountRemoteBasemap(url)
        // The map was handed back while this header was in flight. Mounting now would put a
        // streamed archive over the ride screen's own map with nothing recorded to take it
        // off again, so this loan is simply abandoned — the handback has already left the
        // map in a state it reported to its caller.
        if (generation !== loanGeneration.current) return
        map.current?.remove()
        const created = new MapLibreMap({
          container: container.current!,
          style: basemapStyle(url, themeRef.current, pathModeRef.current),
          center: [-3.2, 54.8],
          zoom: 4.6,
          maxZoom: Math.min(header.maxZoom + 5, 19),
          attributionControl: false,
          pitchWithRotate: false,
          dragRotate: false,
        })
        created.touchZoomRotate.disableRotation()
        created.addControl(new AttributionControl({ compact: true }), 'bottom-left')
        created.on('error', (e) => setError(e.error?.message ?? 'map error'))
        created.once('load', () => setStyleReady(true))
        map.current = created
        remoteRef.current = url
        setStatus('ready')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    },
    [container],
  )

  /**
   * Swaps the palette without touching the archive.
   *
   * `setStyle` replaces every layer, which includes the route line and position dot, so they
   * have to be re-added afterwards — `styledata` fires once the new style is in place. The
   * caller re-supplies the route data, since this hook has no idea what is drawn on it.
   */
  const setTheme = useCallback((next: MapTheme) => {
    setThemeState(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Not remembering the palette is a small annoyance, not a failure.
    }
    const instance = map.current
    const name = activeRef.current?.name
    if (!instance || !name) return
    setStyleReady(false)
    instance.setStyle(basemapStyle(name, next, pathModeRef.current))
    instance.once('styledata', () => {
      ensureRouteLayers(instance)
      setStyleReady(true)
    })
  }, [])

  /**
   * Shows or hides path kinds, by swapping the `paths` layer's filter.
   *
   * Deliberately **not** `setStyle`, which is what the theme swap has to use. `setStyle`
   * replaces every layer, so it takes the route line and position dot with it and they have to
   * be rebuilt — acceptable for a palette change, wasteful for a button a rider might tap three
   * times in a row to cycle the modes. `setFilter` touches one layer and leaves the route alone.
   */
  const setPathMode = useCallback((next: PathMode) => {
    setPathModeState(next)
    try {
      localStorage.setItem(PATHS_KEY, next)
    } catch {
      // Not remembering the path mode is a small annoyance, not a failure.
    }
    // Guarded because the layer only exists once the style has loaded; a tap during the first
    // load would otherwise throw. The style is built with the current mode anyway, so there is
    // nothing to catch up on.
    if (map.current?.getLayer('paths')) map.current.setFilter('paths', pathFilter(next))
  }, [])

  /**
   * Re-reads the installed archives, answering `null` if the engine could not be asked.
   *
   * `null` rather than an empty list, and the difference is a rider's next move. "Nothing is
   * installed" sends them to Setup to download a region; "the engine is broken" is a fault
   * with an entirely different remedy. Collapsing the second into the first — which an empty
   * array did, because every caller then reported `no-basemap` — put a confident, wrong
   * signpost in front of someone whose app was failing for another reason.
   */
  const refresh = useCallback(async (): Promise<{ name: string; bytes: number }[] | null> => {
    try {
      const installed = await sharedEngine().installedBasemaps()
      setArchives(installed)
      return installed
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
      return null
    }
  }, [])

  /**
   * Takes the map down to nothing, leaving no loan outstanding, and says why.
   *
   * Both outcomes leave the rider with no map, but only one of them is a *fault*, and they
   * are kept apart all the way to the words on screen: `nothing-installed` is an empty phone,
   * which the ride screen explains and offers Setup for; `unavailable` means storage could
   * not be read or the archive would not mount, where "download a region" is confident, wrong
   * advice. So the error `refresh` or `show` already set is left standing rather than being
   * papered over with `no-basemap`.
   */
  const discardMap = useCallback((outcome: 'nothing-installed' | 'unavailable'): Handback => {
    map.current?.remove()
    map.current = null
    remoteRef.current = null
    displacedRef.current = null
    activeRef.current = null
    setActive(null)
    setStyleReady(false)
    if (outcome === 'nothing-installed') {
      setStatus('no-basemap')
      // Nothing is installed, which is a state rather than a failure. A message left over
      // from an earlier attempt would read as one.
      setError(null)
    }
    return outcome
  }, [])

  /**
   * Puts the best local archive on screen, or nothing at all — and reports which.
   *
   * The one place that decides what the map shows, shared by the first launch and by the
   * handback, because they had drifted: the startup path and `endRemote` made the same
   * choice from the same inputs in two pieces of code, and only one of them was fixed when
   * `refresh` learned to answer `null`.
   *
   * Nothing here throws. Every outcome is a {@link Handback} the caller can act on, which is
   * the point — the failure this function exists for is one that used to look like success.
   */
  const openLocal = useCallback(
    async (preferences: (string | null)[]): Promise<Handback> => {
      const plan = handbackPlan(await refresh(), preferences)
      if (plan.action === 'discard') return discardMap(plan.outcome)
      // `show` reports rather than throws, and during a loan a failure here would otherwise
      // leave the *streamed* archive up: it only removes the old map once the new one has
      // mounted.
      if (await show(plan.name)) return 'restored'
      return discardMap('unavailable')
    },
    [discardMap, refresh, show],
  )

  /**
   * Gives the map back after a {@link showRemote} loan.
   *
   * Called on every exit from the borrowing screen, not only the successful one, because the
   * unsuccessful exits are the ones that used to break. **It always closes the loan**: when
   * it cannot put a local archive up it takes the borrowed one down instead. An earlier
   * version returned early on an engine fault, which left the streamed archive on screen and
   * told its caller the handback had finished — the exact state `showRemote`'s own comment
   * says must never be reached. What comes back says which of the three things happened, and
   * a caller that ignores it is making that mistake again.
   *
   * Storage is re-read rather than trusting what was there when the loan began: the borrowing
   * screen's whole purpose is to change what is installed, and a rider may have imported a
   * basemap by hand while it was up. The displaced archive is only the *preference*.
   */
  const endRemote = useCallback(async (): Promise<Handback> => {
    // Cancels any loan still loading, so a slow header cannot land after this returns.
    loanGeneration.current += 1
    // Nothing borrowed and a local archive already up: the ride screen's map is its own and
    // there is nothing to give back. Anything else is worth an attempt — that is what makes
    // a retry after a failed handback mean something rather than reporting the same fault
    // back without having tried.
    if (remoteRef.current === null && statusRef.current === 'ready') return 'restored'
    return openLocal([displacedRef.current, remembered()])
  }, [openLocal])

  // Open on whatever is already imported. StrictMode double-invokes effects in dev, and
  // building two Maps over the same container leaks the first one, so this guards.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    // Same three outcomes as a handback, and the same reason they are distinguished: an
    // engine that cannot be asked must not be reported as a phone with nothing on it.
    void openLocal([remembered()])
  }, [openLocal])

  useEffect(
    () => () => {
      map.current?.remove()
      map.current = null
    },
    [],
  )

  return {
    map,
    archives,
    active,
    status,
    error,
    styleReady,
    workerProblem,
    theme,
    setTheme,
    pathMode,
    setPathMode,
    show,
    showRemote,
    endRemote,
    refresh,
    setError,
  }
}
