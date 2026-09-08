import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { filteredAscentM } from './ascent'
import { parseBrouterGpx } from './gpx'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

describe('filteredAscentM', () => {
  it('agrees with BRouter’s own filtered ascend on a long hilly route', () => {
    // The figure the app draws next to it, computed a completely different way inside the
    // engine: 592 m against 589 m over 95 km. This is the test that would catch someone
    // "simplifying" the deadband away, which takes the same route to 943 m.
    const route = parseBrouterGpx(fixture('london-brighton.gpx'))
    expect(filteredAscentM(route.elevations)).toBeCloseTo(route.ascendM, -1)
    expect(Math.abs(filteredAscentM(route.elevations) - route.ascendM) / route.ascendM).toBeLessThan(
      0.01,
    )
  })

  it('reports nothing for a flat urban route, like BRouter', () => {
    const route = parseBrouterGpx(fixture('urban-short.gpx'))
    expect(filteredAscentM(route.elevations)).toBeLessThan(2)
  })

  it('ignores noise below the deadband, however much of it there is', () => {
    const jitter = Array.from({ length: 500 }, (_, i) => 100 + (i % 2) * 5)
    expect(filteredAscentM(jitter)).toBe(0)
  })

  it('follows the line back down, so a descent is not re-credited on the way up', () => {
    // Up 100, down 100, up 100. Two real climbs, not three.
    const there = [0, 100, 0, 100]
    expect(filteredAscentM(there)).toBe(200)
  })

  it('has nothing to say about an empty track', () => {
    expect(filteredAscentM([])).toBe(0)
  })
})
