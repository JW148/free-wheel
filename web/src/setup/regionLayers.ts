import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { RegionEntry } from '../data/manifest'
import type { RegionState } from '../data/regions'

/**
 * The three states a boundary can be in.
 *
 * Chosen on chroma, like the route lines and for the same reason: every stroke in both
 * basemap palettes measures C 15.4 or less, so anything at C 45 or above cannot be mistaken
 * for a boundary that belongs to the map. `regionLayers.test.ts` asserts the floor.
 */
export const REGION_COLOURS = {
  available: '#7aa2f7',
  current: '#3ddc97',
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

export function setRegionData(map: MapLibreMap, collection: GeoJSON.FeatureCollection): void {
  const source = map.getSource(REGION_SOURCE) as GeoJSONSource | undefined
  source?.setData(collection)
}
