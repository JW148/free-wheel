import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { RegionEntry } from '../data/manifest'
import type { RegionState } from '../data/regions'

/**
 * The three states a boundary can be in.
 *
 * Chosen on chroma, like the route lines and for the same reason: every stroke in both
 * basemap palettes measures C 15.4 or less, so anything at C 45 or above cannot be mistaken
 * for a boundary that belongs to the map. `regionLayers.test.ts` asserts the floor.
 *
 * Each also clears ΔE 16 from **every** colour in both palettes — fills and label colours
 * included, not only strokes. That distinction is not academic: an earlier `available` here
 * (`#7aa2f7`) cleared every stroke at 16.94 but sat at ΔE 14.02 from `dark.text.labelWater`,
 * the exact class of gap `profiles.ts` records for the route palette (`fastbike` was ΔE 15.5
 * from that same label, behind a quoted figure of 18.0 that had only been checked against
 * fills and strokes). `#43b1ff`, floated as a fix, turned out to fail the same widened check
 * at ΔE 15.93 against `light.water`. All three colours below were swept at held chroma across
 * hue and lightness against every colour in both palettes; each clears the floor with more
 * margin than the route palette's own worst case (ΔE 17.15):
 *
 * - `available` `#00abff` — worst ΔE 18.00, vs `dark.text.labelWater`.
 * - `current`   `#008b15` — worst ΔE 27.14, vs `light.land.wood`.
 * - `outdated`  `#ffb347` — worst ΔE 19.29, vs `light.line.pathTrack` (unchanged; already clear).
 */
export const REGION_COLOURS = {
  available: '#00abff',
  current: '#008b15',
  outdated: '#ffb347',
} as const

export const REGION_SOURCE = 'regions'
export const REGION_FILL_LAYER = 'regions-fill'
export const REGION_LINE_LAYER = 'regions-line'

/**
 * Region boxes as polygons.
 *
 * A bbox has to become an explicit closed ring: MapLibre will render an unclosed one, just
 * as a sliver rather than an error.
 */
export function regionsGeoJson(
  regions: RegionEntry[],
  states: Record<string, RegionState>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: regions.map(({ id, name, bbox: [west, south, east, north] }) => ({
      type: 'Feature',
      properties: { id, name, state: states[id] ?? 'not-installed' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ]],
      },
    })),
  }
}

/**
 * Adds the picker's own layers.
 *
 * These are chrome over the map rather than part of it, so they follow the route line's
 * rule: high chroma, because every stroke in both basemap palettes is C 15.4 or less and a
 * boundary that reads as map furniture is a boundary nobody taps.
 *
 * Safe to call repeatedly — the map is rebuilt whenever the basemap archive changes (theme
 * switch, style reload), and the caller should not have to track whether this particular
 * instance has been set up yet.
 */
export function ensureRegionLayers(map: MapLibreMap): void {
  if (map.getSource(REGION_SOURCE)) return

  map.addSource(REGION_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    promoteId: 'id',
  })

  map.addLayer({
    id: REGION_FILL_LAYER,
    type: 'fill',
    source: REGION_SOURCE,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': [
        'match',
        ['get', 'state'],
        'current', REGION_COLOURS.current,
        'road-data-outdated', REGION_COLOURS.outdated,
        'map-outdated', REGION_COLOURS.outdated,
        REGION_COLOURS.available,
      ],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.45, 0.18],
    },
  })

  map.addLayer({
    id: REGION_LINE_LAYER,
    type: 'line',
    source: REGION_SOURCE,
    paint: {
      'line-color': [
        'match',
        ['get', 'state'],
        'current', REGION_COLOURS.current,
        'road-data-outdated', REGION_COLOURS.outdated,
        'map-outdated', REGION_COLOURS.outdated,
        REGION_COLOURS.available,
      ],
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.5],
    },
  })
}

/**
 * Takes the picker's layers back off.
 *
 * Symmetric with {@link ensureRegionLayers} and needed for the same reason that one is
 * idempotent: the map instance outlives the screen that decorated it. `App.tsx` owns one
 * controller and hands it to both screens, so a picker that stands down without a download —
 * a rider who imported their files by hand in Setup instead — would otherwise leave region
 * boxes drawn across the ride screen's map.
 *
 * Guarded at every step, because the *common* exit is a different map instance: a finished
 * download rebuilds the map around the downloaded archive, and that one never had these.
 */
export function removeRegionLayers(map: MapLibreMap): void {
  for (const id of [REGION_FILL_LAYER, REGION_LINE_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id)
  }
  if (map.getSource(REGION_SOURCE)) map.removeSource(REGION_SOURCE)
}

export function setRegionData(map: MapLibreMap, collection: GeoJSON.FeatureCollection): void {
  const source = map.getSource(REGION_SOURCE) as GeoJSONSource | undefined
  source?.setData(collection)
}
