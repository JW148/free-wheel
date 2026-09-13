import { describe, expect, it } from 'vitest'
import {
  createPropertyExpression,
  isExpression,
  latest,
} from '@maplibre/maplibre-gl-style-spec'
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl'
import type { MultiLineString, MultiPolygon, Point } from 'geojson'
import type { RegionEntry } from '../data/manifest'
import { chroma, deltaE2000 } from '../map/colour'
import { PALETTES } from '../map/style'
import type { Palette } from '../map/style'
import {
  REGION_COLOURS,
  REGION_FILL_LAYER,
  REGION_LABEL_LAYER,
  REGION_LINE_LAYER,
  REGION_SELECTED_LAYER,
  applyRegionStates,
  beforeWater,
  regionSwatch,
  ensureRegionLayers,
  regionGeometry,
  setSelectedRegion,
} from './regionLayers'

/**
 * Every colour in a palette, not just its strokes.
 *
 * `style.test.ts` has its own copy of this shape for exactly the reason recorded in
 * `profiles.ts`: a figure once measured over fills and strokes but not label colours (ΔE 18.0,
 * quoted for the route palette) was wrong, because `fastbike` sat 15.5 from the dark water
 * label the whole time. Scoping this to `.line` would reintroduce precisely that gap.
 */
function every(palette: Palette): [string, string][] {
  return [
    ['earth', palette.earth],
    ['water', palette.water],
    ['building', palette.building],
    ...Object.entries(palette.land).map(([k, v]): [string, string] => [`land.${k}`, v]),
    ...Object.entries(palette.line).map(([k, v]): [string, string] => [`line.${k}`, v]),
    ...Object.entries(palette.text).map(([k, v]): [string, string] => [`text.${k}`, v]),
  ]
}

const region = (id: string, bbox: [number, number, number, number]): RegionEntry => ({
  id,
  name: id === 'central-scotland' ? 'Central Scotland' : id,
  bbox,
  basemap: { url: `regions/${id}.pmtiles`, bytes: 1, hash: id, built: '2026-09-08' },
  segments: ['W5_N55'],
})

const regions = [
  region('central-scotland', [-5.0, 55.4, -2.4, 56.4]),
  region('southern-scotland', [-4.4, 54.6, -1.6, 55.8]),
]

/**
 * Just enough map to record what the layers would be.
 *
 * A stub rather than a real `Map`: these tests are about the specs handed to MapLibre — which
 * `createPropertyExpression` can then check properly — and standing up WebGL in Node to read
 * them back would test jsdom rather than the style.
 */
function stubMap() {
  const sources = new Map<string, unknown>()
  const added: LayerSpecification[] = []
  const beforeIds: (string | undefined)[] = []
  const filters: Record<string, unknown> = {}
  const states: Record<string, unknown> = {}
  const map = {
    getStyle: () => ({
      layers: [
        { id: 'earth|remote.pmtiles', type: 'fill' },
        { id: 'park|remote.pmtiles', type: 'fill' },
        { id: 'water|remote.pmtiles', type: 'fill' },
        { id: 'roads|remote.pmtiles', type: 'line' },
        { id: 'place-labels|remote.pmtiles', type: 'symbol' },
      ],
    }),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: unknown) => sources.set(id, spec),
    addLayer: (layer: LayerSpecification, before?: string) => {
      added.push(layer)
      beforeIds.push(before)
    },
    getLayer: (id: string) => added.find((layer) => layer.id === id),
    setFilter: (id: string, filter: unknown) => {
      filters[id] = filter
    },
    setFeatureState: ({ id }: { id: string }, state: unknown) => {
      states[id] = state
    },
  }
  return { map: map as unknown as MapLibreMap, added, beforeIds, filters, states, sources }
}

describe('regionGeometry', () => {
  const geometry = regionGeometry(regions)

  it('gives each region one area feature, tapped by its promoted id', () => {
    expect(geometry.areas.features).toHaveLength(2)
    for (const feature of geometry.areas.features) {
      expect(feature.id).toBe(feature.properties?.id)
      expect(feature.geometry.type).toBe('MultiPolygon')
    }
  })

  it('closes every ring, which MapLibre renders unclosed as a sliver', () => {
    for (const feature of geometry.areas.features) {
      for (const polygon of (feature.geometry as MultiPolygon).coordinates) {
        for (const ring of polygon) {
          expect(ring.length).toBeGreaterThanOrEqual(5)
          expect(ring[0]).toEqual(ring[ring.length - 1])
        }
      }
    }
  })

  it('carries a divide and a name anchor for each region', () => {
    const lines = geometry.marks.features.filter((f) => f.geometry.type === 'MultiLineString')
    const points = geometry.marks.features.filter((f) => f.geometry.type === 'Point')
    expect(lines).toHaveLength(2)
    expect(points).toHaveLength(2)
    expect((lines[0].geometry as MultiLineString).coordinates.length).toBeGreaterThan(0)
    expect((points[0].geometry as Point).coordinates).toHaveLength(2)
  })

  it('starts every region as not-installed, so a blank map never claims a download', () => {
    for (const feature of [...geometry.areas.features, ...geometry.marks.features]) {
      expect(feature.properties?.state).toBe('not-installed')
    }
  })
})

describe('applyRegionStates', () => {
  it('stamps the state onto the areas and the divides alike', () => {
    const geometry = applyRegionStates(regionGeometry(regions), {
      'central-scotland': 'current',
      'southern-scotland': 'downloading',
    })
    const stateOf = (id: string) =>
      geometry.areas.features.find((f) => f.properties?.id === id)?.properties?.state
    expect(stateOf('central-scotland')).toBe('current')
    expect(stateOf('southern-scotland')).toBe('downloading')
    for (const feature of geometry.marks.features) {
      if (feature.properties?.id === 'southern-scotland') {
        expect(feature.properties?.state).toBe('downloading')
      }
    }
  })

  it('leaves a region nobody mentioned as not-installed', () => {
    const geometry = applyRegionStates(regionGeometry(regions), {})
    expect(geometry.areas.features[0].properties?.state).toBe('not-installed')
  })

  it('keeps the geometry object, so a progress tick never re-cuts the partition', () => {
    const geometry = regionGeometry(regions)
    const before = geometry.areas.features[0].geometry
    expect(applyRegionStates(geometry, { 'central-scotland': 'current' })).toBe(geometry)
    expect(geometry.areas.features[0].geometry).toBe(before)
  })
})

describe('ensureRegionLayers', () => {
  it('puts the fills and divides under the basemap water, which is what clips them to the coast', () => {
    const { map, added, beforeIds } = stubMap()
    ensureRegionLayers(map)
    for (const [index, layer] of added.entries()) {
      // The name is the exception and has to be: one under the sea is one nobody reads.
      const expected = layer.id === REGION_LABEL_LAYER ? undefined : 'water|remote.pmtiles'
      expect(beforeIds[index], layer.id).toBe(expected)
    }
  })

  /**
   * MapLibre places symbols **top down**, so the topmost symbol layer wins its collisions and
   * the ones below give way. Putting the names under the basemap's own labels was tried on the
   * theory that placement ran the other way, and took the region names actually drawn from 13
   * of 14 to 10.
   */
  it('draws the region names above every other label, which is where they win a collision', () => {
    const { map, added, beforeIds } = stubMap()
    ensureRegionLayers(map)
    expect(beforeIds[added.findIndex((l) => l.id === REGION_LABEL_LAYER)]).toBeUndefined()
  })

  /**
   * A rider downloads the region they have just tapped, which is the usual way round. When the
   * dash lived in a layer of its own the selected ring drew over it, and a region in flight
   * looked exactly like one sitting still.
   */
  it('dashes a region in flight whether or not it is also the selected one', () => {
    const { map, added } = stubMap()
    ensureRegionLayers(map)
    for (const id of [REGION_LINE_LAYER, REGION_SELECTED_LAYER]) {
      const layer = added.find((l) => l.id === id) as { paint: Record<string, unknown> }
      expect(layer.paint['line-dasharray'], id).toEqual([
        'match',
        ['get', 'state'],
        'downloading',
        ['literal', [2, 2]],
        // Solid: `LineAtlas.addRegularDash` splices the zero-length range out.
        ['literal', [1, 0]],
      ])
    }
  })

  it('never draws the merged rectangles of one region as outlines of their own', () => {
    const { map, added } = stubMap()
    ensureRegionLayers(map)
    const fill = added.find((layer) => layer.id === REGION_FILL_LAYER)
    expect((fill as { paint: Record<string, unknown> }).paint['fill-antialias']).toBe(false)
  })

  it('is idempotent, because a theme swap drops the layers and styledata brings them back', () => {
    const { map, added } = stubMap()
    ensureRegionLayers(map)
    const count = added.length
    ensureRegionLayers(map)
    expect(added).toHaveLength(count)
  })

  it('takes its divides and names from the theme, so both palettes are legible', () => {
    for (const theme of ['dark', 'light'] as const) {
      const { map, added } = stubMap()
      ensureRegionLayers(map, theme)
      const label = added.find((layer) => layer.id === REGION_LABEL_LAYER) as {
        paint: Record<string, unknown>
      }
      expect(label.paint['text-color']).toBe(PALETTES[theme].text.label)
      expect(label.paint['text-halo-color']).toBe(PALETTES[theme].text.halo)
    }
  })

  /**
   * The failure this catches is silent. `validateStyleMin` does not check expressions, and
   * MapLibre reports an illegal one as an `error` *event* rather than throwing — so a zoom curve
   * nested inside a `case`, which is what `fill-opacity` here would be if written the obvious
   * way, leaves the map simply never loading.
   */
  it('compiles every paint and layout expression in both themes', () => {
    const SPEC_KEY: Record<string, string> = { line: 'line', fill: 'fill', symbol: 'symbol' }
    for (const theme of ['dark', 'light'] as const) {
      const { map, added } = stubMap()
      ensureRegionLayers(map, theme)
      for (const layer of added) {
        const kind = SPEC_KEY[layer.type]
        for (const group of ['paint', 'layout'] as const) {
          const props = (layer as Record<string, unknown>)[group] as
            | Record<string, unknown>
            | undefined
          for (const [name, value] of Object.entries(props ?? {})) {
            if (!isExpression(value)) continue
            const valueSpec = (latest as Record<string, never>)[`${group}_${kind}`][name]
            // Argument order is (expression, rootKey, spec) — passing the spec second makes
            // every data-driven property report "data expressions not supported".
            const compiled = createPropertyExpression(
              value as never,
              `layers.${layer.id}.${group}.${name}`,
              valueSpec,
            )
            expect(
              compiled.result === 'error' ? compiled.value.map((e) => e.message) : [],
              `${theme} ${layer.id}.${name}`,
            ).toEqual([])
          }
        }
      }
    }
  })
})

describe('setSelectedRegion', () => {
  it('sets every region, because a style reload drops the state along with the layers', () => {
    const { map, states, filters } = stubMap()
    ensureRegionLayers(map)
    setSelectedRegion(map, regions, 'southern-scotland')
    expect(states).toEqual({
      'central-scotland': { selected: false },
      'southern-scotland': { selected: true },
    })
    expect(filters[REGION_SELECTED_LAYER]).toEqual(['==', ['get', 'id'], 'southern-scotland'])
  })

  it('filters the ring to nothing when the rider deselects', () => {
    const { map, filters } = stubMap()
    ensureRegionLayers(map)
    setSelectedRegion(map, regions, null)
    expect(filters[REGION_SELECTED_LAYER]).toEqual(['==', ['get', 'id'], ''])
  })
})

describe('regionSwatch', () => {
  it('reads a region as here once it is here, whether or not it can be checked', () => {
    // `unknown` is installed but offline. Painting it as available blue, which is what the old
    // fallthrough did, told a rider to download something they already had.
    expect(regionSwatch('unknown')).toBe(REGION_COLOURS.current)
    expect(regionSwatch('current')).toBe(REGION_COLOURS.current)
  })

  it('gives an update the outdated colour and everything else the available one', () => {
    expect(regionSwatch('road-data-outdated')).toBe(REGION_COLOURS.outdated)
    expect(regionSwatch('map-outdated')).toBe(REGION_COLOURS.outdated)
    expect(regionSwatch('not-installed')).toBe(REGION_COLOURS.available)
    expect(regionSwatch('downloading')).toBe(REGION_COLOURS.available)
  })

  /*
   * The swatch and the area have to agree about which region is which. They agreed by
   * coincidence while the three hexes were also written out in `ride.css`.
   */
  it('answers with a colour the map layers actually use', () => {
    const states = ['not-installed', 'downloading', 'current', 'unknown', 'map-outdated'] as const
    for (const state of states) {
      expect(Object.values(REGION_COLOURS)).toContain(regionSwatch(state))
    }
  })
})

describe('REGION_COLOURS', () => {
  it('holds every region colour above the chroma floor the route lines use', () => {
    for (const [name, colour] of Object.entries(REGION_COLOURS)) {
      expect(chroma(colour), `${name} (${colour})`).toBeGreaterThanOrEqual(45)
    }
  })

  it('keeps every region colour clear of both basemap palettes, labels included', () => {
    for (const [name, colour] of Object.entries(REGION_COLOURS)) {
      for (const theme of ['dark', 'light'] as const) {
        for (const [key, against] of every(PALETTES[theme])) {
          expect(deltaE2000(colour, against), `${name} vs ${theme}.${key}`)
            .toBeGreaterThanOrEqual(16)
        }
      }
    }
  })

  it('keeps the divides and names achromatic, which is a rule and not a preference', () => {
    // Six route hues at C >= 45 and three region colours have used the usable circle up, so a
    // fourth hue here would have to clear all nine. Lightness has no such budget — but only
    // while these stay under the ceiling every stroke in both palettes is held to.
    for (const theme of ['dark', 'light'] as const) {
      expect(chroma(PALETTES[theme].text.label), theme).toBeLessThanOrEqual(15.4)
    }
  })
})
