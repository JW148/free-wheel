import { describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion } from './manifest'
import { downloadPlan, regionState } from './regions'

const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-11T04:00:00Z',
  picker: { url: 'basemap/uk-z10-8f3a1c2d.pmtiles', bytes: 60959264 },
  segments: {
    W5_N50: { url: 'segments4/W5_N50-bbbb2222.rd5', bytes: 143654912, hash: 'bbbb2222', changed: '2026-09-01T00:00:00Z' },
  },
  regions: [
    { id: 'wessex', name: 'Wessex and the South Coast', bbox: [-2.6, 50.5, -0.7, 51.6],
      basemap: { url: 'regions/wessex-1111aaaa.pmtiles', bytes: 90000000, hash: '1111aaaa', built: '2026-09-08' },
      segments: ['W5_N50'] },
    { id: 'south-west-england', name: 'South West England', bbox: [-5.8, 49.9, -2.4, 51.5],
      basemap: { url: 'regions/south-west-england-2222bbbb.pmtiles', bytes: 70000000, hash: '2222bbbb', built: '2026-09-08' },
      segments: ['W5_N50'] },
  ],
}
const wessex = manifest.regions[0]
const southWest = manifest.regions[1]

const installedWessex: InstalledRegion = {
  id: 'wessex',
  basemapHash: '1111aaaa',
  segmentHashes: { W5_N50: 'bbbb2222' },
  installedAt: Date.parse('2026-09-09T00:00:00Z'),
}

describe('regionState', () => {
  it('reports a region nobody has downloaded', () => {
    expect(regionState(wessex, undefined, true, manifest.segments)).toBe('not-installed')
  })

  it('reports a region whose hashes all match', () => {
    expect(regionState(wessex, installedWessex, true, manifest.segments)).toBe('current')
  })

  it('leads with the road data when both are outdated, because that is the half that misroutes', () => {
    const stale = { ...installedWessex, basemapHash: 'old', segmentHashes: { W5_N50: 'old' } }
    expect(regionState(wessex, stale, true, manifest.segments)).toBe('road-data-outdated')
  })

  it('reports an outdated map on its own', () => {
    expect(regionState(wessex, { ...installedWessex, basemapHash: 'old' }, true, manifest.segments)).toBe(
      'map-outdated',
    )
  })

  it('says unknown rather than current when the manifest could not be refreshed', () => {
    expect(regionState(wessex, installedWessex, false, manifest.segments)).toBe('unknown')
    expect(regionState(wessex, undefined, false, manifest.segments)).toBe('not-installed')
  })

  it('treats a segment the manifest no longer describes as road-data-outdated, not a crash', () => {
    const { W5_N50: _dropped, ...rest } = manifest.segments
    expect(regionState(wessex, installedWessex, true, rest)).toBe('road-data-outdated')
  })
})

describe('downloadPlan', () => {
  it('costs a fresh region as its basemap plus its segments', () => {
    const plan = downloadPlan(wessex, manifest, [])
    expect(plan.items.map((i) => i.key)).toEqual(['wessex', 'W5_N50'])
    expect(plan.bytes).toBe(90000000 + 143654912)
  })

  it('does not re-download a 137 MB segment a neighbouring region already installed', () => {
    const plan = downloadPlan(southWest, manifest, [installedWessex])
    expect(plan.items.map((i) => i.key)).toEqual(['south-west-england'])
    expect(plan.bytes).toBe(70000000)
  })

  it('does re-download a shared segment whose bytes changed upstream', () => {
    const stale = { ...installedWessex, segmentHashes: { W5_N50: 'older111' } }
    const plan = downloadPlan(southWest, manifest, [stale])
    expect(plan.items.map((i) => i.key)).toEqual(['south-west-england', 'W5_N50'])
  })

  it('skips the basemap when only the road data changed', () => {
    const stale = { ...installedWessex, segmentHashes: { W5_N50: 'older111' } }
    const plan = downloadPlan(wessex, manifest, [stale])
    expect(plan.items.map((i) => i.key)).toEqual(['W5_N50'])
  })

  it('re-downloads only the basemap when the road data is current', () => {
    const staleBasemap = { ...installedWessex, basemapHash: 'old' }
    const plan = downloadPlan(wessex, manifest, [staleBasemap])
    expect(plan.items.map((i) => i.key)).toEqual(['wessex'])
    expect(plan.bytes).toBe(90000000)
  })

  it('fails loudly rather than pricing a segment the manifest does not describe as free', () => {
    const { W5_N50: _dropped, ...rest } = manifest.segments
    const strippedManifest = { ...manifest, segments: rest }
    expect(() => downloadPlan(wessex, strippedManifest, [])).toThrow(/does not describe/)
  })
})
