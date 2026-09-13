import type { Feature, FeatureCollection } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { RegionEntry } from '../data/manifest'
import type { RegionState } from '../data/regions'
import { PALETTES, layerRole, type MapTheme } from '../map/style'
import { partitionRegions, type RegionShape } from './regionShapes'

/**
 * The regions, painted onto the map rather than boxed on top of it.
 *
 * ## The sea is drawn by the basemap, not by us
 *
 * These shapes are rectilinear and run well out over the water — see `regionShapes.ts`. They
 * are inserted **below the basemap's own `water` fill**, so the sea paints over them and the
 * coastline clips every region exactly. Nothing here knows where the coast is, nothing has to
 * be re-cut when the archive changes, and it stays right in both themes and at every zoom.
 *
 * That one decision is what makes this feel like a map you already know rather than a diagram
 * over one. It also puts the fills *above* land cover and *below* roads, labels and boundaries,
 * so the country's own features stay legible through the colour.
 *
 * ## Strong fills, and why they could not be before
 *
 * The published boxes overlap — every one of the fourteen shares an edge band with a neighbour —
 * so the old outline layer had to hold its fill at 0.06 or Britain disappeared under a stack of
 * blue rectangles. Alpha compounds. The partition removes the overlap, so a fill can finally be
 * strong enough to answer the question it exists for: which part of the country is this, and
 * have I got it yet.
 *
 * ## Colour says state; shape says selection
 *
 * The three state colours are unchanged and still measured the same way — see
 * {@link REGION_COLOURS}. What changed is that they are now **areas**, which is the looser half
 * of the rule the repo already keeps: a stroke must not be mistakable for a line belonging to
 * the map, an area the size of Yorkshire cannot be mistaken for anything.
 *
 * Everything else on this screen is achromatic, deliberately. The divides, the selected ring and
 * the region names are white or near-black by theme, which is a *lightness* effect — it needs no
 * clearance from the palette, survives dichromacy, and reads over a fill of any colour. It is the
 * same rule the ride overlays follow, and the reason the search for a fourth region colour was
 * abandoned: the usable circle is full.
 */

/**
 * The colours a region can be painted in.
 *
 * Chosen on chroma, like the route lines: every stroke in both basemap palettes measures C 15.4
 * or less, so anything at C 45 or above cannot be mistaken for something the map drew.
 * `regionLayers.test.ts` asserts the floor.
 *
 * Each also clears ΔE 16 from **every** colour in both palettes — fills and label colours
 * included, not only strokes. That distinction is not academic: an earlier `available`
 * (`#7aa2f7`) cleared every stroke at 16.94 but sat at ΔE 14.02 from `dark.text.labelWater`,
 * the exact class of gap `profiles.ts` records for the route palette. `#43b1ff`, floated as a
 * fix, failed the same widened check at ΔE 15.93 against `light.water`. All three below were
 * swept at held chroma across hue and lightness against every colour in both palettes; each
 * clears the floor with more margin than the route palette's own worst case (ΔE 17.15):
 *
 * - `available` `#00abff` — worst ΔE 18.00, vs `dark.text.labelWater`.
 * - `current`   `#008b15` — worst ΔE 27.14, vs `light.land.wood`.
 * - `outdated`  `#ffb347` — worst ΔE 19.29, vs `light.line.pathTrack`.
 */
export const REGION_COLOURS = {
  available: '#00abff',
  current: '#008b15',
  outdated: '#ffb347',
} as const

/**
 * The colour a region is painted in, for a swatch beside its name.
 *
 * The same function the map paints from, rather than the same hexes written out again in CSS.
 * A row in the drawer and an area on the map have to agree about which region is which, and
 * two copies of three colours is exactly the kind of pair where only one ever gets updated.
 */
export function regionSwatch(state: PaintedState): string {
  if (state === 'current' || state === 'unknown') return REGION_COLOURS.current
  if (state === 'road-data-outdated' || state === 'map-outdated') return REGION_COLOURS.outdated
  return REGION_COLOURS.available
}

export const REGION_SOURCE = 'regions'
export const REGION_MARKS_SOURCE = 'region-marks'
export const REGION_FILL_LAYER = 'regions-fill'
export const REGION_LINE_LAYER = 'regions-line'
/** The heavier ring around the region under the rider's finger. */
export const REGION_SELECTED_LAYER = 'regions-selected'
export const REGION_LABEL_LAYER = 'regions-label'

const LAYERS = [
  REGION_FILL_LAYER,
  REGION_LINE_LAYER,
  REGION_SELECTED_LAYER,
  REGION_LABEL_LAYER,
]

/**
 * A dashed divide for a region in flight, and a solid one for every other.
 *
 * Data-driven rather than a layer of its own, which is what this replaced. `line-dasharray` is
 * `cross-faded-data-driven` in MapLibre 6, so a `match` on a *property* is legal — and a solid
 * pattern is spelled `[1, 0]`, which renders solid because `LineAtlas.addRegularDash` splices
 * the zero-length range out and wraps the remainder.
 *
 * The separate layer was fine until a rider downloaded the region they had just tapped, which
 * is the usual way round: the selected ring drew *over* the dashed one and the region in flight
 * looked exactly like a region sitting still. Both line layers now carry the same expression, so
 * the dash survives whatever else is true about the region.
 *
 * What the dash cannot do is read as gaps. Every region draws its **own** edges, so an internal
 * divide is drawn twice — once by each side — and the neighbour's hairline sits in the gaps. So
 * the divide around a region in flight is also three times the width and more than twice the
 * opacity, and what a rider actually sees is the *weight*. The dash still earns its place where
 * a divide is not shared, and it costs nothing.
 */
const DASH_WHEN_PENDING = [
  'match',
  ['get', 'state'],
  'downloading', ['literal', [2, 2]],
  ['literal', [1, 0]],
] as unknown as ExpressionSpecification

/**
 * What a region can be painted as: the four states of {@link RegionState}, plus one for a
 * download that is happening right now.
 *
 * `downloading` gets **no colour of its own**, and that is a finding rather than a shortcut. A
 * search over the whole RGB cube for a fourth colour at C >= 46 clearing ΔE 16 from both basemap
 * palettes, the three colours above *and* the six route colours returns nothing: between them
 * they have used the usable circle up, which is the same wall `profiles.ts` records hitting. So
 * a region in flight keeps the `available` blue and separates on **shape** — a dashed divide —
 * exactly as the basemap's path kinds separate on dash pattern at held chroma.
 */
export type PaintedState = RegionState | 'downloading'

/**
 * The two feature collections the layers draw from.
 *
 * Split because they carry different geometry for the same regions and a MapLibre source may
 * only promote one id per feature. `areas` is what you tap and what carries the colour; `marks`
 * is the divides and the names, which are drawn over the top and never hit-tested.
 */
export interface RegionGeometry {
  areas: FeatureCollection
  marks: FeatureCollection
}

/**
 * Region shapes as MapLibre can use them.
 *
 * The partition is the expensive half and it depends only on the region list, so callers are
 * expected to hold onto this and re-run only {@link applyRegionStates} as downloads land.
 */
export function regionGeometry(regions: RegionEntry[]): RegionGeometry {
  const shapes = partitionRegions(regions)
  return {
    areas: { type: 'FeatureCollection', features: shapes.map(areaFeature) },
    marks: {
      type: 'FeatureCollection',
      features: shapes.flatMap((shape) => [edgeFeature(shape), labelFeature(shape)]),
    },
  }
}

function areaFeature(shape: RegionShape): Feature {
  return {
    type: 'Feature',
    id: shape.id,
    properties: { id: shape.id, name: shape.name, short: shape.short, state: 'not-installed' },
    geometry: {
      type: 'MultiPolygon',
      // Explicitly closed rings, wound anticlockwise from the south-west corner. MapLibre
      // renders an unclosed ring — as a sliver, rather than as an error.
      coordinates: shape.rects.map(([west, south, east, north]) => [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ]),
    },
  }
}

function edgeFeature(shape: RegionShape): Feature {
  return {
    type: 'Feature',
    properties: { id: shape.id, name: shape.name, short: shape.short, state: 'not-installed' },
    geometry: { type: 'MultiLineString', coordinates: shape.edges },
  }
}

function labelFeature(shape: RegionShape): Feature {
  return {
    type: 'Feature',
    properties: { id: shape.id, name: shape.name, short: shape.short, state: 'not-installed' },
    geometry: { type: 'Point', coordinates: shape.anchor },
  }
}

/**
 * Stamps the current state onto a collection, in place of the placeholder it was built with.
 *
 * Mutating the features rather than rebuilding them is what keeps a download's progress ticks
 * off the partition: the geometry is computed once and only the three-character property
 * changes. The caller still has to hand the collection back to `setData`.
 */
export function applyRegionStates(
  geometry: RegionGeometry,
  states: Record<string, PaintedState>,
): RegionGeometry {
  for (const collection of [geometry.areas, geometry.marks]) {
    for (const feature of collection.features) {
      const id = feature.properties?.id
      if (feature.properties && typeof id === 'string') {
        feature.properties.state = states[id] ?? 'not-installed'
      }
    }
  }
  return geometry
}

/**
 * The colour for a state.
 *
 * `unknown` — installed, but the phone is offline and cannot check for an update — takes the
 * same green as `current`. It *is* on the phone, which is what the colour answers; whether it is
 * the newest copy is a sentence, and the row says it. Painting it as available blue, which is
 * what the old fallthrough did, told a rider to download something they already had.
 */
const byState = (colours: typeof REGION_COLOURS): ExpressionSpecification =>
  [
    'match',
    ['get', 'state'],
    'current', colours.current,
    'unknown', colours.current,
    'road-data-outdated', colours.outdated,
    'map-outdated', colours.outdated,
    colours.available,
  ] as unknown as ExpressionSpecification

/**
 * How strongly a region is filled, at one zoom.
 *
 * Four levels, and each one earns its place: the region under your finger, the ones arriving,
 * the ones already here, and the rest. Nothing overlaps any more, so these are the values that
 * actually land on screen rather than values that compound fourteen deep.
 */
const alphaAt = (scale: number): ExpressionSpecification =>
  [
    'case',
    ['boolean', ['feature-state', 'selected'], false], 0.62 * scale,
    ['==', ['get', 'state'], 'downloading'], 0.44 * scale,
    ['==', ['get', 'state'], 'not-installed'], 0.3 * scale,
    0.44 * scale,
  ] as unknown as ExpressionSpecification

/**
 * The tone the divides and the names are drawn in: the theme's own label colour.
 *
 * Achromatic by rule, not by preference — see this file's header. Reusing `text.label` rather
 * than inventing a near-white means the region names sit at exactly the weight of the map's own
 * labels, which is what stops them reading as a separate graphic laid over the top.
 */
const inkFor = (theme: MapTheme) => PALETTES[theme].text

/**
 * Where the region layers go: immediately under the basemap's water, which is what clips them
 * to the coast.
 *
 * Returns `undefined` — meaning "on top of everything" — for a style with no water layer at
 * all, which is what an empty archive list produces. A region drawn over the sea is wrong; a
 * region drawn nowhere is worse.
 */
export function beforeWater(map: MapLibreMap): string | undefined {
  return map.getStyle()?.layers?.find((layer) => layerRole(layer.id) === 'water')?.id
}


/**
 * Adds the region browser's own layers.
 *
 * Safe to call repeatedly, and it has to be: a theme swap goes through `setStyle`, which takes
 * these with it, and `styledata` is where they come back.
 */
export function ensureRegionLayers(map: MapLibreMap, theme: MapTheme = 'dark'): void {
  if (map.getSource(REGION_SOURCE)) return

  const ink = inkFor(theme)
  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }

  map.addSource(REGION_SOURCE, { type: 'geojson', data: empty, promoteId: 'id' })
  map.addSource(REGION_MARKS_SOURCE, { type: 'geojson', data: empty })

  // Under the water fill. Everything below this line is map, everything above it is still map —
  // the regions are simply part of the stack now.
  const under = beforeWater(map)

  map.addLayer(
    {
      id: REGION_FILL_LAYER,
      type: 'fill',
      source: REGION_SOURCE,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': byState(REGION_COLOURS),
        // A region's area arrives as a few dozen merged rectangles, and `fill-antialias` draws
        // an outline around *every ring* — which would trace each of those rectangles in the
        // fill colour and put the grid back on screen. The divides are drawn deliberately,
        // below, and the coastline is the water layer's antialiased edge rather than ours.
        'fill-antialias': false,
        // Zoom has to be the input to a *top-level* interpolate — nesting it inside the `case`
        // is a style validation error that MapLibre reports as an `error` event rather than
        // throwing, so the map would simply never load. Composite functions are the way round
        // it: interpolate on zoom, with a data-driven expression at each stop.
        //
        // It fades because this screen zooms. At country zoom the colour *is* the information;
        // at z10 the rider is checking which town is inside the line, and a 0.6 wash over the
        // street map would be in the way of the thing they came to look at.
        'fill-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          7, alphaAt(1),
          10, alphaAt(0.4),
        ] as unknown as ExpressionSpecification,
      },
    },
    under,
  )

  map.addLayer(
    {
      id: REGION_LINE_LAYER,
      type: 'line',
      source: REGION_MARKS_SOURCE,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': ink.label,
        'line-dasharray': DASH_WHEN_PENDING,
        // A hairline, except where it is saying something. These are internal divides between
        // two coloured areas rather than edges of anything — the country's own edge is the
        // coastline, and the water draws that.
        'line-width': ['case', ['==', ['get', 'state'], 'downloading'], 3, 1],
        'line-opacity': ['case', ['==', ['get', 'state'], 'downloading'], 0.9, 0.4],
      },
    },
    under,
  )

  // Filtered to nothing until something is selected. `setFilter` rather than a feature-state
  // width, because the fill source is the one that promotes ids and this draws from the other.
  map.addLayer(
    {
      id: REGION_SELECTED_LAYER,
      type: 'line',
      source: REGION_MARKS_SOURCE,
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'line-color': ink.label,
        'line-dasharray': DASH_WHEN_PENDING,
        'line-width': 2.5,
        'line-opacity': 0.95,
      },
    },
    under,
  )

  // On top of everything, unlike the rest — a name is only useful if you can read it, and the
  // top is also where it wins. MapLibre places symbols **top down**
  // (`PauseablePlacement.continuePlacement` counts the layer order *down* from the end), so the
  // topmost symbol layer takes the collisions it wants and the ones below give way. Moving this
  // under the basemap's own labels was tried on the theory that placement ran bottom-up, and
  // took the count of region names actually drawn from 13 to 10.
  //
  // It fades out as the rider zooms in, where the map's own place names are the better answer
  // and fourteen region names would be so much furniture.
  map.addLayer(
    {
      id: REGION_LABEL_LAYER,
      type: 'symbol',
      source: REGION_MARKS_SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        // The short name until there is room for the published one. MapLibre drops a label that
        // collides rather than shrinking it, so at country zoom the choice is between short names
        // and five regions with no name at all — which is what the first pass shipped.
        'text-field': ['step', ['zoom'], ['get', 'short'], 6.5, ['get', 'name']],
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 4.5, 10.5, 7, 13.5],
        'text-max-width': 7,
        // Two, not six. Padding is collision margin, and six of it around fourteen labels on an
        // island this shape is the difference between all of them and nine of them.
        'text-padding': 2,
      },
      paint: {
        'text-color': ink.label,
        'text-halo-color': ink.halo,
        'text-halo-width': 1.6,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 1, 9, 0],
      },
    },
  )
}

/** Takes the region layers back off, for a caller that wants to keep the map. */
export function removeRegionLayers(map: MapLibreMap): void {
  for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of [REGION_SOURCE, REGION_MARKS_SOURCE]) {
    if (map.getSource(id)) map.removeSource(id)
  }
}

export function setRegionData(map: MapLibreMap, geometry: RegionGeometry): void {
  ;(map.getSource(REGION_SOURCE) as GeoJSONSource | undefined)?.setData(geometry.areas)
  ;(map.getSource(REGION_MARKS_SOURCE) as GeoJSONSource | undefined)?.setData(geometry.marks)
}

/**
 * Marks one region as the chosen one, or none.
 *
 * Set on **every** region rather than only the two that changed, because a style reload drops
 * feature state along with the layers — so this has to be able to re-establish the whole
 * picture from the current selection alone, without remembering what it said last time.
 */
export function setSelectedRegion(
  map: MapLibreMap,
  regions: RegionEntry[],
  selectedId: string | null,
): void {
  if (map.getSource(REGION_SOURCE)) {
    for (const region of regions) {
      map.setFeatureState(
        { source: REGION_SOURCE, id: region.id },
        { selected: region.id === selectedId },
      )
    }
  }
  if (map.getLayer(REGION_SELECTED_LAYER)) {
    map.setFilter(REGION_SELECTED_LAYER, ['==', ['get', 'id'], selectedId ?? ''])
  }
}
