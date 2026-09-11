import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { RegionEntry } from '../data/manifest'
import type { RegionState } from '../data/regions'

/**
 * The colours a boundary can be painted in.
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
/** The dashed outline over a region that is downloading. See {@link PaintedState}. */
export const REGION_PENDING_LAYER = 'regions-pending'

/**
 * What a boundary can be painted as: the four states of {@link RegionState}, plus one for a
 * download that is happening right now.
 *
 * `downloading` gets **no colour of its own**, and that is a finding rather than a shortcut. A
 * search over the whole RGB cube for a fourth boundary colour at C >= 46 that clears ΔE 16 from
 * both basemap palettes, the three colours below *and* the six route colours returns nothing:
 * between them they have used up the usable circle, which is the same wall `profiles.ts`
 * records hitting. So a region in flight keeps the `available` blue and separates on **shape** —
 * a dashed outline — exactly as the basemap's path kinds separate on dash pattern at held
 * chroma. Shape needs no clearance rule and survives dichromacy, which a seventh hue would not.
 */
export type PaintedState = RegionState | 'downloading'

/**
 * Region boxes as polygons.
 *
 * A bbox has to become an explicit closed ring: MapLibre will render an unclosed one, just
 * as a sliver rather than an error.
 */
export function regionsGeoJson(
  regions: RegionEntry[],
  states: Record<string, PaintedState>,
): FeatureCollection {
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
 * Adds the region browser's own layers.
 *
 * These are chrome over the map rather than part of it, so they follow the route line's
 * rule: high chroma, because every stroke in both basemap palettes is C 15.4 or less and a
 * boundary that reads as map furniture is a boundary nobody taps.
 *
 * Safe to call repeatedly, and it has to be: a theme swap goes through `setStyle`, which takes
 * these with it, and `styledata` is where they come back.
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
      // Nearly transparent for a region that is merely on offer, and that is not timidity.
      // The fourteen published boxes *overlap* — every one of them shares an edge band with a
      // neighbour — so at a uniform 0.18 the whole of Britain came out as a stack of blue
      // rectangles with the coastline barely visible under it. Alpha compounds; a fill that
      // reads correctly alone reads as a wash fourteen times over.
      //
      // So the outline carries a region that is only available, and fill is reserved for the
      // three states where it means something: the one under your finger, the ones on their
      // way, and the ones already here.
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        0.45,
        ['==', ['get', 'state'], 'downloading'],
        0.3,
        ['==', ['get', 'state'], 'not-installed'],
        0.06,
        0.22,
      ],
    },
  })

  map.addLayer({
    id: REGION_LINE_LAYER,
    type: 'line',
    source: REGION_SOURCE,
    filter: ['!=', ['get', 'state'], 'downloading'],
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

  // Its own layer rather than a data-driven dash on the one above: `line-dasharray` is
  // `cross-faded-data-driven` in MapLibre 6, so a `match` on a *property* is fine — but a solid
  // pattern has to be spelled `[1, 0]` and mixing the two into one expression buys nothing
  // over a second layer with a filter.
  map.addLayer({
    id: REGION_PENDING_LAYER,
    type: 'line',
    source: REGION_SOURCE,
    filter: ['==', ['get', 'state'], 'downloading'],
    paint: {
      'line-color': REGION_COLOURS.available,
      'line-dasharray': [2, 2],
      'line-width': 3,
    },
  })
}

/**
 * Takes the region layers back off.
 *
 * Symmetric with {@link ensureRegionLayers}, and now only needed by a caller that wants to keep
 * a map and stop drawing regions on it. `BrowseMap` owns its own instance and simply removes
 * it, so nothing in the app calls this today — it is kept because the pair is the contract, and
 * a half of it is how the old shared-map arrangement left region boxes across the ride screen.
 *
 * Guarded at every step: a map that never had these layers is a legitimate argument.
 */
export function removeRegionLayers(map: MapLibreMap): void {
  for (const id of [REGION_FILL_LAYER, REGION_LINE_LAYER, REGION_PENDING_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id)
  }
  if (map.getSource(REGION_SOURCE)) map.removeSource(REGION_SOURCE)
}

export function setRegionData(map: MapLibreMap, collection: FeatureCollection): void {
  const source = map.getSource(REGION_SOURCE) as GeoJSONSource | undefined
  source?.setData(collection)
}
