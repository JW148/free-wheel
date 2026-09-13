import { useEffect, useMemo, useRef, useState } from 'react'
import { AttributionControl, LngLatBounds, Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import type { RegionEntry } from '../data/manifest'
import { mountRemoteBasemap } from '../map/opfsPmtiles'
import { basemapStyle, type MapTheme } from '../map/style'
import {
  REGION_FILL_LAYER,
  applyRegionStates,
  ensureRegionLayers,
  regionGeometry,
  setRegionData,
  setSelectedRegion,
  type PaintedState,
} from './regionLayers'

/**
 * A map of Britain with the regions drawn on it, for choosing one.
 *
 * ## It is its own MapLibre instance, and that is the point
 *
 * The first version of this screen *borrowed* the ride screen's map: it streamed a map of
 * Britain over the shared instance and handed it back on the way out. That handback was the
 * single most delicate thing in the app — an async teardown racing React's effect ordering,
 * with three separate rounds of fixes recorded against it, and a failure mode where a rider
 * ended up looking at a streamed map of Britain wearing their own map's clothes.
 *
 * None of it was ever about picking a region. It was the cost of there being one map. So this
 * one builds its own, over its own container, and `remove()`s it on unmount — synchronously,
 * with nothing to hand back and nothing to race. The ride screen's map keeps its tiles, its
 * OPFS handles, its route line and its position the entire time, which is also simply better:
 * a rider who opens Maps mid-ride and closes it again is where they left off.
 *
 * Two WebGL contexts at once is the price, and it is a real one on an older phone — but only
 * while this screen is open, and the alternative cost a phase.
 *
 * ## Nothing is downloaded to show this
 *
 * The archive is read over HTTP range straight from the mirror: Britain at z5–z8 is a few
 * hundred kilobytes out of a 61 MB file, so the first screen a rider sees is a real map rather
 * than a list of names they have no way to place.
 *
 * ## The regions are part of the map, not a layer over it
 *
 * They are painted *under* the basemap's water, so the coastline clips them — see
 * `regionLayers.ts` for why that one decision replaces every attempt to cut the shapes to the
 * coast, and `regionShapes.ts` for how fourteen overlapping download boxes become fourteen
 * areas that do not overlap. Nothing on this screen is a rectangle drawn on top of Britain any
 * more; the country *is* the control.
 */
export default function BrowseMap({
  archiveUrl,
  theme,
  regions,
  states,
  selectedId,
  onSelect,
  frame,
  padding,
}: {
  archiveUrl: string
  theme: MapTheme
  regions: RegionEntry[]
  states: Record<string, PaintedState>
  selectedId: string | null
  onSelect: (id: string | null) => void
  /**
   * A region to move the map to, identified by the *identity* of this object rather than by
   * its contents.
   *
   * Choosing from the list has to move the map — a name means nothing until you can see where
   * it is — and choosing on the map must not, or the ground would shift under the finger that
   * just landed on it. Both produce the same `selectedId`, so the difference cannot be read
   * from the selection; a fresh wrapper is the caller saying which one happened.
   */
  frame: { region: RegionEntry } | null
  /** What the chrome covers, so `fitBounds` frames the part of the map a rider can see. */
  padding: { top: number; bottom: number }
}) {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The selection handler must not be a dependency of the effect that builds the map, or every
  // parent render would tear the map down and stream the archive again.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // Built once. `archiveUrl` and `theme` are deliberately not dependencies: the URL is fixed
  // for the life of the manifest, and a theme swap is handled below by `setStyle` rather than
  // by rebuilding — which would otherwise drop the region layers with it.
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const header = await mountRemoteBasemap(archiveUrl)
        if (!live || !container.current) return
        const created = new MapLibreMap({
          container: container.current,
          style: basemapStyle(archiveUrl, theme),
          // Somewhere plausible to start. The real framing is `fitBounds` below, which cannot
          // run until the map exists — without a centre here it would open on null island and
          // visibly jump.
          center: [-3.2, 54.8],
          zoom: 4.6,
          maxZoom: Math.min(header.maxZoom + 2, 12),
          attributionControl: false,
          pitchWithRotate: false,
          dragRotate: false,
        })
        created.touchZoomRotate.disableRotation()
        // Top-right, unlike everywhere else in the app. The bar and the drawer both live at the
        // bottom of this screen, and the OSM attribution is a licence requirement rather than
        // decoration, so it goes in the corner nothing else ever claims.
        created.addControl(new AttributionControl({ compact: true }), 'top-right')
        created.on('error', (e) => setError(e.error?.message ?? 'map error'))
        created.once('load', () => {
          ensureRegionLayers(created, theme)
          setReady(true)
        })
        created.on('click', (event: MapMouseEvent) => {
          if (!created.getLayer(REGION_FILL_LAYER)) return
          const [feature] = created.queryRenderedFeatures(event.point, {
            layers: [REGION_FILL_LAYER],
          })
          const id = feature?.properties?.id
          onSelectRef.current(typeof id === 'string' ? id : null)
        })
        map.current = created
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      live = false
      map.current?.remove()
      map.current = null
    }
  }, [archiveUrl, theme])

  // A palette swap while this screen is open. `ensureRegionLayers` is idempotent and has to be:
  // `setStyle` takes the region layers with it, and `styledata` is where they come back.
  const firstTheme = useRef(theme)
  useEffect(() => {
    const instance = map.current
    if (!instance || theme === firstTheme.current) return
    firstTheme.current = theme
    setReady(false)
    instance.setStyle(basemapStyle(archiveUrl, theme))
    instance.once('styledata', () => {
      ensureRegionLayers(instance, theme)
      setReady(true)
    })
  }, [archiveUrl, theme])

  // Cut once per region list. The partition is the only expensive thing on this screen, and a
  // download ticking its progress must not re-run it — `applyRegionStates` writes the state onto
  // the features that already exist, which is why it takes the geometry back rather than a list.
  const geometry = useMemo(() => regionGeometry(regions), [regions])

  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return
    setRegionData(instance, applyRegionStates(geometry, states))
  }, [ready, geometry, states])

  /**
   * Frames every region, allowing for what is on top of the map.
   *
   * A fixed centre and zoom cannot do this. The bar covers the bottom of the screen, so a map
   * centred on Britain puts the south coast *behind it* — the first version of this screen
   * opened on half a screen of empty sea with England under the sheet. `padding` is the only
   * thing that knows the difference between the viewport and the part of it a rider can see,
   * and the bounds come from the regions themselves so this keeps working if the published list
   * changes shape.
   *
   * Once only: re-framing on every state change would yank the map back from wherever the rider
   * had panned every time a download ticked.
   */
  const framed = useRef(false)
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready || framed.current || regions.length === 0) return
    framed.current = true
    const bounds = new LngLatBounds()
    for (const region of regions) {
      bounds.extend([region.bbox[0], region.bbox[1]])
      bounds.extend([region.bbox[2], region.bbox[3]])
    }
    instance.fitBounds(bounds, {
      padding: { ...padding, left: 24, right: 24 },
      animate: false,
    })
  }, [ready, regions, padding])

  /**
   * Moves to one region, when the rider picked it by name rather than by pointing at it.
   *
   * Animated, and deliberately: this is the one moment where the list and the map have to be
   * tied together, and a jump would leave the rider working out what they were looking at. The
   * `frame` object's identity is the signal — see the prop's own note.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready || !frame) return
    const [west, south, east, north] = frame.region.bbox
    instance.fitBounds(new LngLatBounds([west, south], [east, north]), {
      padding: { ...padding, left: 32, right: 32 },
      // Room to see what is around it. A region framed exactly to its own edges could be
      // anywhere; the neighbours are how a rider checks they have the right one.
      maxZoom: 8,
      duration: 600,
    })
  }, [ready, frame, padding])

  // Re-established from the current selection alone on every style reload, which drops feature
  // state along with the layers — so this never has to remember what it said last time.
  useEffect(() => {
    const instance = map.current
    if (!instance || !ready) return
    setSelectedRegion(instance, regions, selectedId)
  }, [ready, regions, selectedId])

  return (
    <div className="browse-map">
      <div ref={container} className="browse-map-canvas" />
      {error && (
        <p className="picker-detail browse-map-error" role="status">
          {error}
        </p>
      )}
    </div>
  )
}
