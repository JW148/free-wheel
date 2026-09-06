import { describe, expect, it } from 'vitest'
import {
  createPropertyExpression,
  featureFilter,
  isExpression,
  latest,
  validateStyleMin,
} from '@maplibre/maplibre-gl-style-spec'
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'
import { basemapStyle, nextPathMode } from './style'

// `basemapStyle` resolves glyph and sprite URLs against the document origin, because they are
// fetched from MapLibre's worker where a relative URL would resolve against `/assets/`. Under
// Node there is no `location`, so stand one up. This works only because the style resolves it
// lazily rather than at module load — which is itself why that changed.
Object.defineProperty(globalThis, 'location', {
  value: new URL('http://localhost:4174/'),
  configurable: true,
})

describe('basemapStyle', () => {
  const style = basemapStyle('edinburgh.pmtiles')

  it('constrains every fill layer to polygon geometry', () => {
    // Protomaps ships linear water — canals, streams, rivers — as LineStrings in the *same*
    // `water` source-layer as lakes and reservoirs. Decoding tile 14/8045/5107 over Edinburgh:
    //
    //     LineString kind=canal x1, LineString kind=stream x1, Polygon kind=water x2
    //
    // MapLibre's fill bucket closes a LineString into a ring and fills it, so an unfiltered
    // fill layer paints the Union Canal as a lake-sized slab straight across the tile. That
    // is the "tears in the map" bug. Every fill layer needs the guard, not just water —
    // `landuse` and `landcover` carry linear features in other regions too.
    const fills = style.layers.filter((layer) => layer.type === 'fill')
    expect(fills.length).toBeGreaterThan(0)

    for (const layer of fills) {
      expect(
        JSON.stringify('filter' in layer ? layer.filter : null),
        `fill layer "${layer.id}" must filter to Polygon geometry`,
      ).toContain('geometry-type')
    }
  })

  it('draws linear water as lines instead of discarding it', () => {
    // Filtering the fill layer alone would silently lose every canal and stream — and a
    // canal towpath is one of the better things to be riding on.
    const lines = style.layers.filter(
      (l) => l.type === 'line' && 'source-layer' in l && l['source-layer'] === 'water',
    )
    expect(lines).toHaveLength(1)
    expect(JSON.stringify(lines[0])).toContain('LineString')
  })
})

/**
 * Evaluates a layer's real filter against a synthetic feature, rather than string-matching the
 * filter expression. The combinations below are not invented — they are what
 * `pmtiles tile edinburgh.pmtiles 14 8046 5105` actually decodes to over central Edinburgh:
 *
 *     minor_road/residential 111, path/footway 65, minor_road/service 57, major_road/tertiary 33,
 *     path/steps 28, path/pedestrian 22, path/cycleway 6, path/sidewalk 2, path/crossing 2,
 *     path/corridor 2, path/path 1
 *
 * plus path/track and path/pier out in the Pentlands and along the coast.
 */
function accepts(layer: LayerSpecification, kind: string, detail: string): boolean {
  const filter = 'filter' in layer ? layer.filter : undefined
  if (!filter) return true
  return featureFilter(filter, `layers.${layer.id}.filter`).filter(
    { zoom: 14 } as never,
    { type: 2, properties: { kind, kind_detail: detail } } as never,
    {} as never,
  )
}

function layer(style: StyleSpecification, id: string): LayerSpecification {
  const found = style.layers.find((l) => l.id === id)
  if (!found) throw new Error(`no layer "${id}" in style`)
  return found
}

/** Everything a bike can be ridden or pushed along, as Protomaps names it. */
const RIDEABLE = ['cycleway', 'track', 'path', 'bridleway']
const WALKED = ['footway', 'pedestrian', 'steps']
/** Never useful to a cyclist: a sidewalk duplicates a road you can already see, a crossing is
 *  a few metres of paint, a corridor is *inside a building*, and a pier goes nowhere. */
const NEVER = ['sidewalk', 'crossing', 'corridor', 'pier']

describe('path rendering', () => {
  it('draws paths in their own layer, not as roads', () => {
    // The `roads-casing` layer paints a dark casing up to 8px wide under everything it
    // matches. Applied to a footway that is most of the ink, and it is why paths currently
    // read as heavily as the streets they run beside.
    const style = basemapStyle('edinburgh.pmtiles')
    for (const id of ['roads', 'roads-casing']) {
      expect(accepts(layer(style, id), 'path', 'cycleway'), `${id} must not draw paths`).toBe(
        false,
      )
      expect(
        accepts(layer(style, id), 'minor_road', 'residential'),
        `${id} must still draw roads`,
      ).toBe(true)
    }
  })

  it('draws only the cyclist-relevant kinds in rideable mode', () => {
    const paths = layer(basemapStyle('edinburgh.pmtiles', 'dark', 'rideable'), 'paths')
    for (const detail of RIDEABLE) expect(accepts(paths, 'path', detail), detail).toBe(true)
    for (const detail of WALKED) expect(accepts(paths, 'path', detail), detail).toBe(false)
  })

  it('adds the walked kinds in all mode', () => {
    const paths = layer(basemapStyle('edinburgh.pmtiles', 'dark', 'all'), 'paths')
    for (const detail of [...RIDEABLE, ...WALKED])
      expect(accepts(paths, 'path', detail), detail).toBe(true)
  })

  it('draws nothing in none mode', () => {
    const paths = layer(basemapStyle('edinburgh.pmtiles', 'dark', 'none'), 'paths')
    for (const detail of [...RIDEABLE, ...WALKED])
      expect(accepts(paths, 'path', detail), detail).toBe(false)
  })

  it('never draws sidewalks, crossings, corridors or piers in any mode', () => {
    // The filter is an allowlist rather than a denylist, so a `kind_detail` Protomaps adds in
    // a future schema version cannot quietly appear on the map.
    for (const mode of ['rideable', 'all', 'none'] as const) {
      const paths = layer(basemapStyle('edinburgh.pmtiles', 'dark', mode), 'paths')
      for (const detail of NEVER)
        expect(accepts(paths, 'path', detail), `${detail} in ${mode}`).toBe(false)
    }
  })

  it('keeps paths above roads so a cycleway is not buried under a street', () => {
    const style = basemapStyle('edinburgh.pmtiles')
    const ids = style.layers.map((l) => l.id)
    expect(ids.indexOf('paths')).toBeGreaterThan(ids.indexOf('roads'))
    expect(ids.indexOf('paths')).toBeLessThan(ids.indexOf('road-labels'))
  })
})

describe('style validity', () => {
  // MapLibre reports a style problem as an `error` *event* on the map rather than throwing, so
  // a bad expression does not fail loudly — the map simply never loads. That has already cost
  // this project once, over a `zoom` nested inside a `match`. Compiling every expression here
  // turns the whole class of mistake into a test failure.
  //
  // Both halves earn their place, verified by planting real bugs and watching this fail:
  // `validateStyleMin` catches a zoom curve nested inside a `match` ("zoom expression may only
  // be used as input to a top-level step or interpolate"), and `createPropertyExpression`
  // catches expressions that are individually well-formed but not legal for the property they
  // are attached to — a data expression on a camera-only property, say.
  const SPEC_KEY: Record<string, string> = {
    line: 'line',
    fill: 'fill',
    symbol: 'symbol',
    background: 'background',
  }

  it('compiles every paint and layout expression in every theme and path mode', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const mode of ['rideable', 'all', 'none'] as const) {
        const style = basemapStyle('edinburgh.pmtiles', theme, mode)
        expect(
          validateStyleMin(style).map((e) => `${e.message}`),
          `${theme}/${mode}`,
        ).toEqual([])

        for (const layer of style.layers) {
          const kind = SPEC_KEY[layer.type]
          for (const group of ['paint', 'layout'] as const) {
            const props = (layer as Record<string, unknown>)[group] as
              | Record<string, unknown>
              | undefined
            for (const [name, value] of Object.entries(props ?? {})) {
              // Only expressions. A legacy constant like `line-dasharray: [2, 2]` is a
              // perfectly valid style value that `createPropertyExpression` rejects, because
              // MapLibre resolves constants down a different path — `validateStyleMin` above
              // is what covers those.
              if (!isExpression(value)) continue
              const valueSpec = (latest as Record<string, never>)[`${group}_${kind}`][name]
              // Argument order is (expression, rootKey, spec) — passing the spec second
              // makes `supportsPropertyExpression` fall over a string and report every
              // data-driven property as "data expressions not supported".
              const compiled = createPropertyExpression(
                value as never,
                `layers.${layer.id}.${group}.${name}`,
                valueSpec,
              )
              expect(
                compiled.result === 'error' ? compiled.value.map((e) => e.message) : [],
                `${theme}/${mode} ${layer.id}.${name}`,
              ).toEqual([])
            }
          }
        }
      }
    }
  })
})

describe('nextPathMode', () => {
  it('cycles rideable to all to none and back', () => {
    // Order matters: `rideable` is the default and the useful one, so a rider who taps the
    // button once by accident lands on *more* information rather than a blank map.
    expect(nextPathMode('rideable')).toBe('all')
    expect(nextPathMode('all')).toBe('none')
    expect(nextPathMode('none')).toBe('rideable')
  })
})
