import { describe, expect, it } from 'vitest'
import type { RegionEntry } from '../data/manifest'
import { chroma, deltaE2000 } from '../map/colour'
import { PALETTES } from '../map/style'
import { REGION_COLOURS, regionsGeoJson } from './regionLayers'

const regions: RegionEntry[] = [
  { id: 'central-scotland', name: 'Central Scotland', bbox: [-5.0, 55.4, -2.4, 56.4],
    basemap: { url: 'regions/central-scotland-1c9d4e77.pmtiles', bytes: 1, hash: '1c9d4e77', built: '2026-09-08' },
    segments: ['W5_N55'] },
]

describe('regionsGeoJson', () => {
  it('closes each ring, which an unclosed polygon renders as a sliver', () => {
    const [feature] = regionsGeoJson(regions, {}).features
    const ring = (feature.geometry as GeoJSON.Polygon).coordinates[0]
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4])
  })

  it('winds the ring anticlockwise from the south-west corner', () => {
    const [feature] = regionsGeoJson(regions, {}).features
    const ring = (feature.geometry as GeoJSON.Polygon).coordinates[0]
    expect(ring[0]).toEqual([-5.0, 55.4])
    expect(ring[1]).toEqual([-2.4, 55.4])
    expect(ring[2]).toEqual([-2.4, 56.4])
  })

  it('carries the id, name and state so the layers can paint and the click can identify', () => {
    const [feature] = regionsGeoJson(regions, { 'central-scotland': 'current' }).features
    expect(feature.properties).toEqual({
      id: 'central-scotland',
      name: 'Central Scotland',
      state: 'current',
    })
  })

  it('defaults a region with no record to not-installed', () => {
    const [feature] = regionsGeoJson(regions, {}).features
    expect(feature.properties?.state).toBe('not-installed')
  })
})

describe('REGION_COLOURS', () => {
  it('holds every boundary colour above the chroma floor the route lines use', () => {
    for (const [name, colour] of Object.entries(REGION_COLOURS)) {
      expect(chroma(colour), `${name} (${colour})`).toBeGreaterThanOrEqual(45)
    }
  })

  it('keeps every boundary clear of both basemap palettes, labels included', () => {
    for (const [name, colour] of Object.entries(REGION_COLOURS)) {
      for (const theme of ['dark', 'light'] as const) {
        for (const [key, against] of Object.entries(PALETTES[theme].line)) {
          expect(deltaE2000(colour, against), `${name} vs ${theme}.line.${key}`)
            .toBeGreaterThanOrEqual(16)
        }
      }
    }
  })
})
