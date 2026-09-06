import { describe, expect, it } from 'vitest'
import { basemapStyle } from './style'

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
