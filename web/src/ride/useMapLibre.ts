import { useCallback, useEffect, useRef, useState } from 'react'
import { AttributionControl, Map as MapLibreMap } from 'maplibre-gl'
import { mountBasemap, registerPmtilesProtocol } from '../map/opfsPmtiles'
import { checkMapLibreWorker, configureMapLibreWorker } from '../map/maplibreWorker'
import { addArchiveToMap, removeArchiveFromMap } from '../map/composite'
import { basemapStyle, layerRole, pathFilter, sourceIdFor, type MapTheme, type PathMode } from '../map/style'
import { archiveToOpen, mountPlan, type MapOutcome } from '../map/archiveChoice'
import { sharedEngine } from '../engine/engineClient'
import { ensureRouteLayers } from './routeLayers'

/** Re-exported so a caller of {@link useMapLibre} does not have to know where it lives. */
export type { MapOutcome }

// Both at module scope, before any Map can exist. `addProtocol` is global to the maplibre
// module rather than per-instance, and the worker URL is read when the pool is first
// created — a Map constructed before either is set up fails silently. This cost Phase 3;
// see `maplibreWorker.ts` and CLAUDE.md.
registerPmtilesProtocol()
export const workerUrl = configureMapLibreWorker()

/**
 * Remembered so the app opens looking at the region you were last riding in.
 *
 * Every downloaded region is on the map at once now, so this no longer decides *what* is
 * drawn — only where the camera starts.
 */
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

/** The archive last looked at, or null if there is none or storage is unreadable. */
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
 * Owns the MapLibre instance and every OPFS archive behind it.
 *
 * ## Every downloaded region is drawn, all the time
 *
 * A phone holds one PMTiles archive per region it has downloaded, and the map carries a source
 * — and a full set of layers — for each. There is no "current" archive a rider has to pick, and
 * no boundary at which the map goes blank while routing carries on working, which is what the
 * single-archive version did at every region edge. `active` below is only where the camera
 * started; it decides nothing about what is drawn.
 *
 * The ordering that makes this work lives in `map/style.ts` and `map/composite.ts`: layers are
 * interleaved by role across archives, never stacked archive by archive.
 *
 * ## `sync` is the only way the map changes
 *
 * Startup, a finished download, a hand-imported archive and a deleted region all go through
 * {@link useMapLibre.sync}, which reads what is installed and reconciles the map against it.
 * One entry point rather than four, because the previous arrangement had two pieces of code
 * making the same decision from the same inputs and only one of them ever got fixed.
 *
 * Reconciling **splices** rather than rebuilds. A region that finishes downloading while the
 * rider is following a route must not take the route line, the position dot and the waypoint
 * markers off the screen, which a new `Map` or a `setStyle` both would.
 */
export function useMapLibre(container: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<MapLibreMap | null>(null)
  const [archives, setArchives] = useState<{ name: string; bytes: number }[]>([])
  /** Every archive currently drawn, which after a successful sync is every installed one. */
  const [mounted, setMounted] = useState<string[]>([])
  const mountedRef = useRef<string[]>([])
  const [active, setActive] = useState<BasemapInfo | null>(null)
  const activeRef = useRef<BasemapInfo | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [workerProblem, setWorkerProblem] = useState<string | null>(null)
  /** Flipped once the style has loaded, so callers know it is safe to touch layers. */
  const [styleReady, setStyleReady] = useState(false)
  const [theme, setThemeState] = useState<MapTheme>(storedTheme)
  // `sync` needs the current theme but must not be rebuilt when it changes, or every theme
  // switch would tear the map down and remount every archive.
  const themeRef = useRef(theme)
  themeRef.current = theme
  const [pathMode, setPathModeState] = useState<PathMode>(storedPathMode)
  const pathModeRef = useRef(pathMode)
  pathModeRef.current = pathMode

  // A dead MapLibre worker produces no error event and no failed request — the map simply
  // never draws. Asking directly is the only cheap way to tell that apart from an empty
  // archive, so the check stays in the shipping app rather than only in diagnostics.
  useEffect(() => {
    void checkMapLibreWorker().then(setWorkerProblem)
  }, [])

  const rememberFocus = useCallback((name: string) => {
    try {
      localStorage.setItem(LAST_BASEMAP_KEY, name)
    } catch {
      // Not remembering where you were is a small annoyance, not a failure.
    }
  }, [])

  /**
   * Takes the map down to nothing, leaving nothing mounted, and says why.
   *
   * Both outcomes leave the rider with no map, but only one of them is a *fault*, and they are
   * kept apart all the way to the words on screen: `nothing-installed` is an empty phone, which
   * the ride screen explains and offers Setup for; `unavailable` means storage could not be
   * read or an archive would not mount, where "download a region" is confident, wrong advice.
   * So the error `sync` already set is left standing rather than papered over with `no-basemap`.
   *
   * **Total.** Refs are cleared before `remove()`, which is the one line here that can throw, so
   * a failed teardown costs the pixels but never the invariant.
   */
  const discardMap = useCallback((outcome: 'nothing-installed' | 'unavailable'): MapOutcome => {
    const doomed = map.current
    map.current = null
    mountedRef.current = []
    setMounted([])
    activeRef.current = null
    setActive(null)
    setStyleReady(false)
    if (outcome === 'nothing-installed') {
      setStatus('no-basemap')
      // Nothing is installed, which is a state rather than a failure. A message left over from
      // an earlier attempt would read as one.
      setError(null)
    } else {
      setStatus('error')
    }
    try {
      doomed?.remove()
    } catch {
      // Nothing points at this instance any more, so it cannot be drawn on or reported on.
      // Swallowed so that this function is total: every caller may state that the map is down.
    }
    return outcome
  }, [])

  /**
   * Builds a map from scratch over every named archive, centred on `focus`.
   *
   * Only for the case where there is no map yet — a cold start, or the first archive arriving
   * on an empty phone. Everything else splices; see {@link sync}.
   */
  const buildMap = useCallback(
    async (names: string[], focus: string): Promise<boolean> => {
      setError(null)
      setStyleReady(false)
      try {
        // Sequential rather than `Promise.all`: each mount opens an OPFS sync access handle
        // through the shared registry, and the registry de-duplicates in-flight opens per
        // path rather than serialising across them. Sequential keeps the first-launch failure
        // legible — the archive that would not open is named by the error that throws.
        const headers = new Map<string, Awaited<ReturnType<typeof mountBasemap>>>()
        for (const name of names) headers.set(name, await mountBasemap(name))
        const header = headers.get(focus) ?? headers.values().next().value
        if (!header) throw new Error('no archive to open')

        map.current?.remove()
        const created = new MapLibreMap({
          container: container.current!,
          style: basemapStyle(names, themeRef.current, pathModeRef.current),
          center: header.center,
          zoom: 12,
          // Past the deepest archive's own max zoom, not at it: MapLibre overzooms vector
          // tiles by scaling the deepest tile it has, so capping here would put street-level
          // detail permanently out of reach on a map whose whole job is street-level detail.
          maxZoom: Math.min(Math.max(...[...headers.values()].map((h) => h.maxZoom)) + 5, 19),
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
          ensureRouteLayers(created, themeRef.current)
          setStyleReady(true)
        })

        map.current = created
        mountedRef.current = [...names]
        setMounted([...names])
        activeRef.current = header
        setActive(header)
        setStatus('ready')
        rememberFocus(header.name)
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return false
      }
    },
    [container, rememberFocus],
  )

  /**
   * Brings the map in line with what is installed, and reports what the rider ended up with.
   *
   * Called on startup, whenever a download finishes, whenever an archive is imported by hand
   * and whenever a region is removed. It is deliberately idempotent and cheap when nothing has
   * changed: the common case after a background download is one `addSource` and one pass of
   * `addLayer`, with the rest of the map — and everything the ride screen has drawn on it —
   * untouched.
   *
   * Nothing here throws. Every outcome is a {@link MapOutcome} the caller can act on, which is
   * the point: the failure worth naming is one that used to look like success.
   */
  const sync = useCallback(
    async (options: { focus?: string | null } = {}): Promise<MapOutcome> => {
      let installed: { name: string; bytes: number }[]
      try {
        installed = await sharedEngine().installedBasemaps()
        setArchives(installed)
      } catch (e) {
        // `null` rather than an empty list, and the difference is a rider's next move.
        // "Nothing is installed" sends them to download a region; "the engine is broken" is a
        // fault with an entirely different remedy, and confident wrong advice is worse than
        // none.
        setError(e instanceof Error ? e.message : String(e))
        return discardMap('unavailable')
      }

      const plan = mountPlan(installed, mountedRef.current, [options.focus, remembered()])
      if (plan.action === 'discard') return discardMap(plan.outcome)

      const instance = map.current
      if (!instance || mountedRef.current.length === 0) {
        return (await buildMap(plan.mount, plan.focus)) ? 'ready' : discardMap('unavailable')
      }

      try {
        for (const name of plan.remove) {
          removeArchiveFromMap(instance, name)
        }
        for (const name of plan.add) {
          const header = await mountBasemap(name)
          addArchiveToMap(instance, name, themeRef.current, pathModeRef.current)
          instance.setMaxZoom(Math.min(Math.max(instance.getMaxZoom(), header.maxZoom + 5), 19))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        // Not a discard: the archives that were already up are still up and still correct, so
        // taking the whole map down would turn one archive that would not open into no map at
        // all. The caller is told, and the rider keeps what works.
        mountedRef.current = plan.mount.filter((name) => instance.getSource(sourceIdFor(name)))
        setMounted([...mountedRef.current])
        return 'partial'
      }

      mountedRef.current = [...plan.mount]
      setMounted([...plan.mount])
      setStatus('ready')
      if (options.focus && plan.mount.includes(options.focus)) rememberFocus(options.focus)
      return 'ready'
    },
    [buildMap, discardMap, rememberFocus],
  )

  /**
   * Moves the camera to an archive without changing what is drawn.
   *
   * The counterpart to every region being on the map at once: "show me Yorkshire" is now a
   * camera move rather than a mount, so it costs nothing and loses nothing.
   */
  const flyToArchive = useCallback(
    async (name: string) => {
      const instance = map.current
      if (!instance) return
      try {
        const header = await mountBasemap(name)
        instance.easeTo({ center: header.center, zoom: 10, duration: 700 })
        activeRef.current = header
        setActive(header)
        rememberFocus(name)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [rememberFocus],
  )

  /**
   * Swaps the palette without touching the archives.
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
    if (!instance || mountedRef.current.length === 0) return
    setStyleReady(false)
    instance.setStyle(basemapStyle(mountedRef.current, next, pathModeRef.current))
    instance.once('styledata', () => {
      ensureRouteLayers(instance, next)
      setStyleReady(true)
    })
  }, [])

  /**
   * Shows or hides path kinds, by swapping the filter on every `paths` layer.
   *
   * Deliberately **not** `setStyle`, which is what the theme swap has to use. `setStyle`
   * replaces every layer, so it takes the route line and position dot with it and they have to
   * be rebuilt — acceptable for a palette change, wasteful for a button a rider might tap three
   * times in a row to cycle the modes.
   *
   * Every `paths` layer, plural: there is one per mounted archive, so filtering only the first
   * would leave the neighbouring region's footways on screen after the rider asked for them to
   * go. Found by role rather than by name so this does not need the archive list.
   */
  const setPathMode = useCallback((next: PathMode) => {
    setPathModeState(next)
    try {
      localStorage.setItem(PATHS_KEY, next)
    } catch {
      // Not remembering the path mode is a small annoyance, not a failure.
    }
    const instance = map.current
    // Guarded because the layers only exist once the style has loaded; a tap during the first
    // load would otherwise throw. The style is built with the current mode anyway, so there is
    // nothing to catch up on.
    if (!instance || !instance.isStyleLoaded()) return
    for (const layer of instance.getStyle().layers) {
      if (layerRole(layer.id) === 'paths') instance.setFilter(layer.id, pathFilter(next))
    }
  }, [])

  // Open on whatever is already installed. StrictMode double-invokes effects in dev, and
  // building two Maps over the same container leaks the first one, so this guards.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void sync()
  }, [sync])

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
    mounted,
    active,
    status,
    error,
    styleReady,
    workerProblem,
    theme,
    setTheme,
    pathMode,
    setPathMode,
    sync,
    flyToArchive,
    /** The archive the camera would open on, for a caller that wants to name it. */
    preferred: () => archiveToOpen(archives, [remembered()]),
    setError,
  }
}
