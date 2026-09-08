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
import type { MapTheme, Palette, PaletteLand } from './style'
import { PALETTES } from './style'
import { LAND_TIERS, type LandClass } from './landcover'
import { chroma, deltaE2000 } from './colour'
import { ROUTE_PALETTE } from '../ride/profiles'

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

/**
 * The palette rules, as assertions rather than prose.
 *
 * `docs/phase-4-progress.md` records these constraints as measured figures in a document. A
 * document does not fail a build, and the palette they describe has now been edited twice.
 * Everything below is a rule that was previously only written down.
 */
describe('palette', () => {
  const THEMES: MapTheme[] = ['dark', 'light']

  /**
   * The chroma ceiling, and what it does and does not cover.
   *
   * The figure comes from `pathTrack`, the most colourful *stroke* in the basemap: C 15.13 on
   * dark, C 15.30 on light. (`docs/phase-4-progress.md` quotes 15.1, which is the dark value —
   * the light theme has always been a shade over it.)
   *
   * It applies to **strokes only**. The argument behind it is that a route line must not be
   * mistaken for a line belonging to the map, and that is a statement about lines. A large
   * area fill is not a candidate for being mistaken for a 5px route stroke, so land fills are
   * deliberately allowed above it — which is the entire point of this change, and why the
   * `park` fill can sit at C 23.6 while `pathTrack` may not.
   */
  const LINE_CHROMA_CEILING = 15.4

  /**
   * How close a route colour is allowed to get to anything in the basemap.
   *
   * Measured worst case is 17.15 on light (`fastbike` against water) and 17.81 on dark
   * (`fastbike` against the water label). Blue is the binding case in both, exactly as
   * `docs/phase-4-progress.md` predicted: the basemap spends blue-grey on water, roads and
   * boundaries, so there is nowhere for a blue line to go.
   *
   * The floor sits at 16 to leave a little room, and it is *higher* than what shipped —
   * the previous palette's true worst was 15.5, not the 18.0 quoted in `profiles.ts`, which
   * was measured over a subset that left the label colours out.
   */
  const ROUTE_CLEARANCE_FLOOR = 16

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

  it('gives every land class a colour in both themes', () => {
    const classes = LAND_TIERS.flatMap((tier) => tier.classes)
    for (const theme of THEMES) {
      for (const cls of classes) {
        expect(PALETTES[theme].land[cls], `${theme}.land.${cls}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('keeps every stroke colour under the chroma ceiling', () => {
    for (const theme of THEMES) {
      for (const [name, colour] of Object.entries(PALETTES[theme].line)) {
        expect(chroma(colour), `${theme}.line.${name} (${colour})`).toBeLessThanOrEqual(
          LINE_CHROMA_CEILING,
        )
      }
    }
  })

  it('allows land fills above the stroke ceiling, because that is the point', () => {
    // A guard against someone "restoring consistency" by pulling the fills back under the
    // line ceiling, which would undo this change and reinstate a map measured at ΔE 2.8
    // between a park and a building.
    const greens = THEMES.map((theme) => chroma(PALETTES[theme].land.park))
    expect(Math.max(...greens)).toBeGreaterThan(LINE_CHROMA_CEILING)
  })

  it('keeps every route colour clear of every basemap colour', () => {
    for (const theme of THEMES) {
      for (const profile of ROUTE_PALETTE) {
        for (const [name, colour] of every(PALETTES[theme])) {
          expect(
            deltaE2000(profile.colour, colour),
            `${profile.id} (${profile.colour}) vs ${theme}.${name} (${colour})`,
          ).toBeGreaterThanOrEqual(ROUTE_CLEARANCE_FLOOR)
        }
      }
    }
  })

  it('separates the surfaces a rider orients by', () => {
    // The whole complaint, in numbers. Every one of these pairs was between ΔE 2.8 and 4.6 in
    // the palette that shipped, because all 43 land kinds were painted one colour.
    const FLOORS: [keyof PaletteLand | 'earth' | 'water', keyof PaletteLand | 'earth' | 'water', number][] = [
      ['park', 'earth', 15],
      ['park', 'residential', 15],
      ['water', 'earth', 15],
      ['garden', 'earth', 8],
      ['park', 'garden', 6],
      ['farm', 'grass', 8],
      ['wood', 'park', 6],
      ['park', 'sport', 5],
      ['residential', 'industrial', 4.5],
    ]
    const resolve = (palette: Palette, key: string): string =>
      key === 'earth' ? palette.earth : key === 'water' ? palette.water : palette.land[key as LandClass]

    for (const theme of THEMES) {
      for (const [a, b, floor] of FLOORS) {
        const palette = PALETTES[theme]
        expect(
          deltaE2000(resolve(palette, a), resolve(palette, b)),
          `${theme}: ${a} vs ${b}`,
        ).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('halos labels in the earth colour so a street name survives crossing a park', () => {
    for (const theme of THEMES) {
      expect(PALETTES[theme].text.halo).toBe(PALETTES[theme].earth)
    }
  })
})

describe('land-cover layers', () => {
  const style = basemapStyle('edinburgh.pmtiles')

  it('draws every tier against the landuse source-layer', () => {
    for (const tier of LAND_TIERS) {
      expect(style.layers.find((l) => l.id === tier.id), `missing layer "${tier.id}"`).toBeDefined()
    }
  })

  it('draws a low-zoom layer only for tiers that landcover can actually fill', () => {
    // `landcover` is live at z3-z7 where `landuse` is nearly empty, so it needs its own
    // layers — but its vocabulary is six kinds, not 43. A `-low` layer for a tier holding
    // none of them filters for kinds that source-layer never contains and can never draw
    // anything: dead weight, and a style that claims to do something it cannot.
    const lowIds = style.layers.filter((l) => l.id.endsWith('-low')).map((l) => l.id)

    // urban_area -> residential, farmland/barren/glacier -> land-open, forest/grassland -> land-green
    expect(lowIds).toEqual(['land-built-low', 'land-open-low', 'land-green-low'])
  })

  it('paints land fills opaquely', () => {
    // The old style used `fill-opacity: 0.5` to hide the fact that overlapping landuse
    // polygons have no defined draw order — Protomaps stamps `sort_rank` 189 on every one of
    // them. Blending made the ordering not matter, at the cost of a washed-out map and a
    // colour at every overlap that nobody chose. Tiers fix the ordering properly, so the
    // opacity crutch must not come back.
    const land = style.layers.filter((l) => l.id.startsWith('land-'))
    expect(land.length).toBeGreaterThan(0)
    for (const layer of land) {
      const opacity = (layer as { paint?: Record<string, unknown> }).paint?.['fill-opacity']
      expect(opacity, `${layer.id} must not be translucent`).toBeUndefined()
    }
  })

  it('keeps all land below the roads and above the background', () => {
    const ids = style.layers.map((l) => l.id)
    for (const tier of LAND_TIERS) {
      expect(ids.indexOf(tier.id), tier.id).toBeGreaterThan(ids.indexOf('background'))
      expect(ids.indexOf(tier.id), tier.id).toBeLessThan(ids.indexOf('roads'))
    }
  })

  it('draws water above the land but below the roads', () => {
    const ids = style.layers.map((l) => l.id)
    expect(ids.indexOf('water')).toBeGreaterThan(ids.indexOf('land-park'))
    expect(ids.indexOf('water')).toBeLessThan(ids.indexOf('roads'))
  })
})

describe('railways', () => {
  const style = basemapStyle('edinburgh.pmtiles')

  it('does not draw a railway as a road', () => {
    // `roads` carries `kind: 'rail'` — 265 features in a 137-tile scan of the Edinburgh
    // archive — and the old filter excluded only paths, so every railway was painted with the
    // road colour and the full 8px road casing. A main line looked like a street you could
    // ride down, which is the opposite of what a railway means to a cyclist.
    for (const id of ['roads', 'roads-casing']) {
      expect(accepts(layer(style, id), 'rail', 'rail'), `${id} must not draw rail`).toBe(false)
      expect(
        accepts(layer(style, id), 'minor_road', 'residential'),
        `${id} must still draw roads`,
      ).toBe(true)
    }
  })

  it('draws railways in their own layer', () => {
    expect(accepts(layer(style, 'rail'), 'rail', 'rail')).toBe(true)
    expect(accepts(layer(style, 'rail'), 'minor_road', 'residential')).toBe(false)
  })
})
