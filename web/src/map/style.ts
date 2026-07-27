import type { StyleSpecification } from 'maplibre-gl'

/**
 * A deliberately minimal basemap style for the Protomaps v4 schema.
 *
 * **No text layers, and that is on purpose for now.** Labels need glyph PBFs, which the
 * PMTiles archive does not contain and which MapLibre fetches separately — the classic
 * offline-MapLibre trap the plan warns about. Rendering geometry first proves the
 * OPFS → PMTiles → MapLibre pipeline in isolation; glyphs are their own piece of work, and
 * bolting them on now would confuse a glyph failure with a tile-plumbing failure.
 *
 * Also note this is **not** mapcn's default CARTO basemap, which is online-only and requires
 * a CARTO Enterprise licence for commercial use. Nothing here talks to a server.
 *
 * Layer names come from the archive's own metadata (`pmtiles show --metadata`), not guesswork:
 * boundaries, buildings, earth, landcover, landuse, places, pois, roads, water.
 */

const COLOURS = {
  earth: '#f6f4f0',
  water: '#a8c8e8',
  green: '#dfe9d8',
  building: '#e6e2dc',
  road: '#ffffff',
  roadCasing: '#d8d2c8',
  major: '#fdf3d8',
  path: '#cbbfa8',
  boundary: '#b0a8a0',
}

export function basemapStyle(archive: string): StyleSpecification {
  return {
    version: 8,
    // No glyphs or sprite declared: any layer needing them would fail at load rather than
    // silently fetch from the network, which is what we want while offline is the point.
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${archive}`,
        attribution:
          '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLOURS.earth } },
      {
        id: 'earth',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'earth',
        paint: { 'fill-color': COLOURS.earth },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        paint: { 'fill-color': COLOURS.green, 'fill-opacity': 0.6 },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landuse',
        paint: { 'fill-color': COLOURS.green, 'fill-opacity': 0.5 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': COLOURS.water },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'buildings',
        minzoom: 13,
        paint: { 'fill-color': COLOURS.building },
      },
      // Casing under the fill, so roads read as lines rather than a flat wash.
      {
        id: 'roads-casing',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        paint: {
          'line-color': COLOURS.roadCasing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 8],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'highway',
            COLOURS.major,
            'major_road',
            COLOURS.major,
            'path',
            COLOURS.path,
            COLOURS.road,
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 6],
        },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundaries',
        paint: { 'line-color': COLOURS.boundary, 'line-dasharray': [2, 2], 'line-width': 1 },
      },
    ],
  }
}
