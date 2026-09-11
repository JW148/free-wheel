import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { segmentsForBbox } from './geometry.mjs'

const regions = JSON.parse(readFileSync(new URL('../regions.json', import.meta.url), 'utf8'))

const covers = (lon, lat) =>
  regions.some(({ bbox: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n)

/**
 * A coarse outline of mainland Great Britain, traced roughly along the coast from Land's End
 * clockwise and back.
 *
 * Written out by hand rather than pulled from a dataset: this test runs with no network and
 * nothing installed, and a shapefile would be a dependency the mirror does not
 * otherwise have. It is deliberately crude — a straight line across the Bristol Channel, the
 * Wash, the Moray Firth and the Firth of Forth means the test asks for coverage over some
 * water, which costs nothing because every region bbox is a rectangle that spills into the sea
 * anyway.
 *
 * Mainland only. Offshore islands — Wight, Anglesey, Man, Arran, Skye, the Hebrides, Orkney,
 * Shetland, Scilly — are outside this ring and so are never swept; they are asserted by name in
 * `covers the offshore islands` below instead. Two of them fall in no region:
 *
 * - **the Isles of Scilly** (−6.31, 49.92), below 50.0°N, out for the same reason as the Lizard
 *   tip that `ACCEPTED_GAPS` declares: the row beneath is Brittany and the Bay of Biscay.
 * - **Shetland**, above 59.5°N. Not a segment-cost decision, whatever an earlier version of this
 *   comment said: a *standalone* Shetland region computes to `W5_N55` + `W5_N60`, which passes
 *   the two-segment rule below, and `W5_N60` is **327,756 bytes** — a third of a megabyte, and
 *   `docs/phase-2-progress.md` measured adding Shetland as costing almost nothing. What it
 *   actually costs is a fifteenth region and a basemap cut of its own. That is the owner's call
 *   and needs a measurement of the cut, so nothing here bans the cell.
 */
const MAINLAND = [
  [-5.72, 50.07], [-5.48, 50.21], [-5.08, 50.41], [-4.55, 50.83], [-4.20, 51.02], [-4.12, 51.20],
  [-3.47, 51.22], [-2.98, 51.35], [-2.70, 51.50], [-2.67, 51.64], [-3.17, 51.46], [-3.70, 51.48],
  [-3.94, 51.62], [-4.30, 51.56], [-4.16, 51.68], [-4.70, 51.67], [-5.04, 51.71], [-5.27, 51.88],
  [-4.98, 52.01], [-4.66, 52.08], [-4.08, 52.41], [-4.05, 52.72], [-4.13, 52.92], [-4.27, 53.14],
  [-4.13, 53.23], [-3.83, 53.32], [-3.49, 53.32], [-3.13, 53.25], [-3.10, 53.29], [-2.98, 53.41],
  [-2.99, 53.64], [-3.05, 53.82], [-2.87, 54.07], [-3.23, 54.11], [-3.27, 54.21], [-3.41, 54.35],
  [-3.61, 54.49], [-3.55, 54.64], [-3.39, 54.87], [-2.94, 54.89], [-3.06, 54.99], [-3.26, 54.98],
  [-4.05, 54.83], [-4.44, 54.87], [-5.03, 54.90], [-5.12, 54.84], [-4.86, 55.24], [-4.63, 55.46],
  [-4.87, 55.79], [-4.75, 55.95], [-4.73, 56.00], [-4.92, 55.95], [-5.42, 55.87], [-5.61, 55.43],
  [-5.80, 55.31], [-5.70, 55.60], [-5.50, 55.90], [-5.44, 56.03], [-5.47, 56.41], [-5.11, 56.82],
  [-5.83, 57.00], [-5.72, 57.28], [-5.70, 57.72], [-5.16, 57.90], [-5.02, 58.26], [-4.75, 58.57],
  [-3.52, 58.59], [-3.07, 58.64], [-3.09, 58.44], [-3.65, 58.12], [-3.98, 57.97], [-4.06, 57.81],
  [-4.22, 57.48], [-3.87, 57.58], [-3.29, 57.72], [-2.96, 57.68], [-2.52, 57.67], [-2.00, 57.69],
  [-1.77, 57.51], [-2.09, 57.15], [-2.21, 56.96], [-2.47, 56.71], [-2.58, 56.56], [-2.87, 56.46],
  [-2.79, 56.34], [-2.61, 56.28], [-3.16, 56.11], [-3.19, 55.95], [-2.52, 56.00], [-2.09, 55.87],
  [-2.00, 55.77], [-1.61, 55.39], [-1.42, 55.02], [-1.38, 54.91], [-1.21, 54.69], [-1.07, 54.61],
  [-0.61, 54.49], [-0.40, 54.28], [-0.19, 54.08], [-0.03, 53.73], [-0.08, 53.57], [0.26, 53.34],
  [0.34, 53.14], [0.02, 52.98], [0.40, 52.75], [0.49, 52.94], [0.85, 52.96], [1.30, 52.93],
  [1.73, 52.61], [1.75, 52.48], [1.68, 52.33], [1.60, 52.15], [1.35, 51.96], [1.29, 51.94],
  [1.15, 51.79], [0.71, 51.54], [0.76, 51.44], [1.38, 51.38], [1.42, 51.33], [1.31, 51.13],
  [1.18, 51.08], [0.57, 50.86], [0.29, 50.77], [-0.14, 50.82], [-1.09, 50.80], [-1.40, 50.90],
  [-1.87, 50.72], [-1.96, 50.61], [-2.45, 50.61], [-2.94, 50.72], [-3.41, 50.62], [-3.53, 50.46],
  [-4.14, 50.37], [-4.45, 50.35], [-5.06, 50.15], [-5.20, 49.96], [-5.50, 50.00],
]

/**
 * The two places on the mainland that fall in no region, and why each is left that way.
 *
 * Both are a bbox edge sitting on a line of BRouter's 5°×5° segment grid, where the next
 * nudge outward costs a whole extra segment — the constraint the `at most two segments` test
 * below enforces, and the reason the bboxes sit where they do at all. Recorded here rather
 * than in a comment so that closing one makes the "still needed" test fail and prompts its
 * removal.
 */
const ACCEPTED_GAPS = [
  {
    what: 'the Lizard tip, south of 50.0°N',
    // south-west-england stops at exactly 50.0. Below that line the grid hands out W5_N45 and
    // W10_N45 — Brittany and the Bay of Biscay — for a few square kilometres of Cornwall. The
    // Isles of Scilly are out on the same line; they are offshore, so the sweep never reaches
    // them and they are asserted by name instead.
    box: [-5.4, 49.90, -5.15, 50.0],
  },
  {
    what: 'the Rhins of Galloway, west of 5.0°W',
    // southern-scotland stops at exactly -5.0. Reaching Stranraer means crossing into W10_N50
    // and W10_N55, taking the region from two segments to four.
    box: [-5.2, 54.80, -5.0, 55.0],
  },
]

const inGap = (lon, lat) =>
  ACCEPTED_GAPS.some(({ box: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n)

/** Ray casting. Points exactly on an edge are not worth worrying about at this resolution. */
function insideMainland(lon, lat) {
  let hit = false
  for (let i = 0, j = MAINLAND.length - 1; i < MAINLAND.length; j = i++) {
    const [xi, yi] = MAINLAND[i]
    const [xj, yj] = MAINLAND[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** Every mainland point on a 0.02° grid — about 2 km, fine enough to find a one-town hole. */
function sweepMainland() {
  const step = 0.02
  const points = []
  for (let lat = 49.8; lat <= 61.001; lat = Math.round((lat + step) * 1000) / 1000) {
    for (let lon = -8.8; lon <= 2.001; lon = Math.round((lon + step) * 1000) / 1000) {
      if (insideMainland(lon, lat)) points.push([lon, lat])
    }
  }
  return points
}

describe('regions.json', () => {
  it('gives every region a unique id and a name', () => {
    const ids = regions.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const region of regions) {
      expect(region.id).toMatch(/^[a-z0-9-]+$/)
      expect(region.name.length).toBeGreaterThan(2)
    }
  })

  it('orders every bbox west, south, east, north', () => {
    for (const { id, bbox } of regions) {
      const [west, south, east, north] = bbox
      expect(west, id).toBeLessThan(east)
      expect(south, id).toBeLessThan(north)
    }
  })

  /**
   * The test the eleven-named-cities assertion this replaces could not do.
   *
   * Naming cities only proves the cities named are covered, and the holes a rectangle list
   * leaves are between the places anyone thinks to name: the bboxes shipped for a while with
   * Oxford, Gloucester, Aberdeen, Berwick-upon-Tweed, Skegness, Colchester and the whole of
   * Kintyre in no region at all, under an all-green test.
   */
  it('leaves no mainland point in no region at all', () => {
    const holes = sweepMainland().filter(([lon, lat]) => !covers(lon, lat) && !inGap(lon, lat))
    // Reported as a count plus a handful of coordinates: a bad bbox leaves thousands of
    // points uncovered, and a failure message that prints all of them buries the one fact
    // worth reading, which is roughly where the hole is.
    const sample = holes.slice(0, 8).map(([lon, lat]) => `${lon},${lat}`)
    expect({ count: holes.length, sample }).toEqual({ count: 0, sample: [] })
  })

  it('still needs every accepted gap it declares', () => {
    const mainland = sweepMainland()
    for (const { what, box } of ACCEPTED_GAPS) {
      const [w, s, e, n] = box
      const uncovered = mainland.filter(
        ([lon, lat]) => lon >= w && lon <= e && lat >= s && lat <= n && !covers(lon, lat),
      )
      // If this fails, a bbox grew and closed the gap: delete the entry rather than keeping a
      // documented hole that no longer exists.
      expect(uncovered.length, what).toBeGreaterThan(0)
    }
  })

  /**
   * The islands, which the mainland sweep cannot reach.
   *
   * Asserted rather than described, for the reason `ACCEPTED_GAPS` is declared rather than
   * commented: the comment above claimed for a while that Shetland was the only island in no
   * region, while the Isle of Man and the Isles of Scilly were uncovered too and only one of
   * them was written down anywhere.
   */
  it('covers the offshore islands, and names the two it does not', () => {
    expect(covers(-1.30, 50.68), 'Isle of Wight').toBe(true)
    expect(covers(-4.40, 53.28), 'Anglesey').toBe(true)
    // Reached by widening north-west-england to −4.9, which still computes to one segment.
    expect(covers(-4.48, 54.15), 'Isle of Man').toBe(true)
    expect(covers(-5.22, 55.58), 'Arran').toBe(true)
    expect(covers(-6.20, 57.40), 'Skye').toBe(true)
    expect(covers(-6.60, 58.20), 'Lewis').toBe(true)
    expect(covers(-2.96, 58.98), 'Orkney').toBe(true)

    // The two that are not, both recorded in the sweep comment above and in
    // `docs/phase-8-progress.md`. If one of these starts passing, delete it from both.
    expect(covers(-6.31, 49.92), 'Isles of Scilly').toBe(false)
    expect(covers(-1.15, 60.15), 'Shetland').toBe(false)
  })

  it('covers the towns an earlier bbox set left in no region', () => {
    // Regression cases, all of them real holes this file's own test used to pass over.
    expect(covers(-1.26, 51.75), 'Oxford').toBe(true)
    expect(covers(-2.24, 51.86), 'Gloucester').toBe(true)
    expect(covers(-2.08, 51.90), 'Cheltenham').toBe(true)
    expect(covers(-2.09, 57.15), 'Aberdeen').toBe(true)
    expect(covers(-2.21, 56.96), 'Stonehaven').toBe(true)
    expect(covers(-1.77, 57.51), 'Peterhead').toBe(true)
    expect(covers(-2.00, 55.77), 'Berwick-upon-Tweed').toBe(true)
    expect(covers(0.34, 53.14), 'Skegness').toBe(true)
    expect(covers(-0.08, 53.57), 'Grimsby').toBe(true)
    expect(covers(0.90, 51.89), 'Colchester').toBe(true)
    expect(covers(-5.61, 55.43), 'Campbeltown').toBe(true)
  })

  it('needs at most two segments per region, so no download carries a spare 137 MB', () => {
    for (const region of regions) {
      expect(segmentsForBbox(region.bbox).length, region.id).toBeLessThanOrEqual(2)
    }
  })

  it('asks for no segment outside the British Isles', () => {
    // Expressed as the box the isles sit in rather than a list of cell names, because a list
    // encodes today's regions as a rule. The previous version named five cells and so banned
    // `W5_N60` outright — which would have failed anyone covering Shetland, for a file of
    // 327,756 bytes. The cost this test is about is the one that is actually large:
    //
    // - **south of 50°N** the grid hands out `W10_N45`, `W5_N45` and `E0_N45` — the Bay of
    //   Biscay, Brittany, Normandy. `E0_N45` alone is 126 MB, for a cell whose only British
    //   land is the Lizard and the Scillies.
    // - **west of 10°W** is open Atlantic, and **east of 5°E** is the wrong country.
    //
    // Ireland is not excludable by name and is deliberately not tried: `W10_N50` and `W10_N55`
    // hold it, and also hold Cornwall, Pembrokeshire and Kintyre, so nothing here can tell an
    // Irish cell bought on purpose from a Welsh coastline bought by necessity. What keeps one
    // from being paid for is the two-segment budget above, not this test.
    const britishIsles = new Set(segmentsForBbox([-10, 50, 5, 61]))
    for (const region of regions) {
      for (const name of segmentsForBbox(region.bbox)) {
        expect(britishIsles.has(name), `${region.id} wants ${name}`).toBe(true)
      }
    }
  })
})
