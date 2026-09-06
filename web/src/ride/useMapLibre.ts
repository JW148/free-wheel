import { useCallback, useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap } from 'maplibre-gl'
import { mountBasemap, registerPmtilesProtocol } from '../map/opfsPmtiles'
import { checkMapLibreWorker, configureMapLibreWorker } from '../map/maplibreWorker'
import { basemapStyle, type MapTheme } from '../map/style'
import { sharedEngine } from '../engine/engineClient'
import { ensureRouteLayers } from './routeLayers'

// Both at module scope, before any Map can exist. `addProtocol` is global to the maplibre
// module rather than per-instance, and the worker URL is read when the pool is first
// created — a Map constructed before either is set up fails silently. This cost Phase 3;
// see `maplibreWorker.ts` and CLAUDE.md.
registerPmtilesProtocol()
export const workerUrl = configureMapLibreWorker()

/** Remembered so the app opens on the archive you were last using, not an arbitrary one. */
const LAST_BASEMAP_KEY = 'free-wheel.basemap.v1'
const THEME_KEY = 'free-wheel.theme.v1'

function storedTheme(): MapTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
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

  // A dead MapLibre worker produces no error event and no failed request — the map simply
  // never draws. Asking directly is the only cheap way to tell that apart from an empty
  // archive, so the check stays in the shipping app rather than only in diagnostics.
  useEffect(() => {
    void checkMapLibreWorker().then(setWorkerProblem)
  }, [])

  const show = useCallback(
    async (name: string) => {
      setError(null)
      setStyleReady(false)
      try {
        const header = await mountBasemap(name)

        map.current?.remove()
        const created = new MapLibreMap({
          container: container.current!,
          style: basemapStyle(name, themeRef.current),
          center: header.center,
          zoom: 12,
          // Past the archive's own max zoom, not at it: MapLibre overzooms vector tiles by
          // scaling the deepest tile it has, so capping here would put street-level detail
          // permanently out of reach on a map whose whole job is street-level detail.
          maxZoom: Math.min(header.maxZoom + 5, 19),
          attributionControl: { compact: true },
          // A rotated map is disorienting on a bike and easy to trigger by accident with a
          // gloved two-finger touch. Pitch likewise buys nothing here.
          pitchWithRotate: false,
          dragRotate: false,
        })
        created.touchZoomRotate.disableRotation()

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
        setStatus('ready')
        try {
          localStorage.setItem(LAST_BASEMAP_KEY, name)
        } catch {
          // Not remembering the archive is a small annoyance, not a failure.
        }
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
    instance.setStyle(basemapStyle(name, next))
    instance.once('styledata', () => {
      ensureRouteLayers(instance)
      setStyleReady(true)
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const installed = await sharedEngine().installedBasemaps()
      setArchives(installed)
      return installed
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
      return []
    }
  }, [])

  // Open on whatever is already imported. StrictMode double-invokes effects in dev, and
  // building two Maps over the same container leaks the first one, so this guards.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const installed = await refresh()
      if (installed.length === 0) {
        setStatus('no-basemap')
        return
      }
      const remembered = localStorage.getItem(LAST_BASEMAP_KEY)
      const pick = installed.find((a) => a.name === remembered) ?? installed[0]
      await show(pick.name)
    })()
  }, [refresh, show])

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
    show,
    refresh,
    setError,
  }
}
