import type { RegionEntry } from '../data/manifest'

/**
 * Turns the published region **boxes** into areas you can point at on a map.
 *
 * ## Why a box is the wrong thing to draw
 *
 * A region is published as a bounding box because that is what `pmtiles extract` takes and what
 * a BRouter grid cell is priced in. Drawn literally, fourteen of them stacked over Britain is
 * what this replaced: rectangles in the sea, rectangles over each other, and a coastline barely
 * visible underneath. Every one of the fourteen shares an edge band with a neighbour, so the
 * fills had to be held at 0.06 opacity to stop the country vanishing under a blue wash — which
 * defeated the one thing the fill was for.
 *
 * The rider does not care about the extract's geometry. They care *which part of the country
 * this is*, and they already know what the country looks like. So the boxes become a partition:
 * every point in the published coverage belongs to exactly one region, and nothing overlaps, so
 * a fill can be strong enough to read.
 *
 * The sea is handled by **draw order**, not by geometry — see `regionLayers.ts`. These shapes
 * are still square-cornered out over the water; they are painted *underneath* the basemap's own
 * water fill, so the coastline clips them exactly, for free, and stays right in both themes and
 * at every zoom.
 *
 * ## The divide is drawn from a seed, and geometry alone could not do it
 *
 * Two rules were tried and both failed on the same class of city. **Nearest box centre** put the
 * Scottish divide north of Edinburgh, because Central Scotland's box is wide and Southern
 * Scotland's is tall and the midpoint between two centres means nothing on the ground.
 * **Deepest inside the box** — distance to the nearest box edge — fixed Scotland and then broke
 * four English cities: Manchester came out as Yorkshire, Hull as East Anglia, Carlisle as
 * Scotland, Shrewsbury as Wales. All four are the same failure. A box is a *download extent*,
 * drawn with a generous, deliberately asymmetric overlap, and a city can sit 20 km inside its
 * own region's edge while sitting 60 km inside its neighbour's. No measurement of the boxes
 * recovers an intent that was never written into them.
 *
 * So it is written down: {@link REGION_SEEDS} names the heart of each region, and a cell goes to
 * the nearest seed **among the regions whose box actually covers it**. The clip is what keeps
 * this honest — a seed can only ever redistribute coverage that was published, never invent it,
 * so the painted area is always a subset of what a download would fetch. A region with no seed
 * falls back to its box centre and still works, which is what a published region this file has
 * never heard of gets.
 *
 * ## Everything downstream is a grid
 *
 * A uniform {@link CELL_DEGREES} grid. The divides between seeds are diagonal, and a grid built
 * from box edges would render one as two or three enormous steps; at 0.05° a step is about 5 km,
 * which is under two pixels at the zoom this screen opens on — 0.1° was tried first and the
 * staircase down the middle of Scotland was visible. Cells are merged back into
 * maximal rectangles for the fill and into runs for the outline, so MapLibre receives a few
 * dozen shapes per region rather than nine thousand.
 */

/**
 * The resolution the partition is computed at, in degrees.
 *
 * Fine enough that a diagonal divide reads as a diagonal at z5 rather than as a staircase,
 * coarse enough that the whole of Britain is about 36,000 cells — one pass over fourteen boxes,
 * done once when the manifest loads.
 */
export const CELL_DEGREES = 0.05

/**
 * The heart of each published region: roughly where a rider would put their finger if asked to
 * point at it.
 *
 * This is **presentation data**, which is why it lives in the app rather than in the manifest.
 * It decides only which of two regions paints a place that both of them cover, and it is
 * clipped to the published boxes, so the worst a wrong seed can do is colour a town as its
 * neighbour. It cannot affect what is downloaded or what BRouter can route on.
 *
 * The first is a real place on land, and is also where the region's **name** is drawn — a
 * centroid of the painted area would be arithmetically neater and would put "Highlands and
 * Islands" in the sea off Skye.
 *
 * `regionShapes.test.ts` asserts every seed sits inside its own published box, and walks forty
 * British cities to check the divides land where a rider would draw them.
 */
export const REGION_SEEDS: Record<string, [number, number][]> = {
  'highlands-islands': [[-4.6, 57.6]], // Inverness and the Great Glen
  'central-scotland': [[-4.3, 56.0]], // between Glasgow and Stirling
  'southern-scotland': [[-3.3, 55.3]], // the Borders
  'north-east-england': [[-1.6, 54.85]], // Durham and Tyneside
  // Two, because one cannot be near both ends of it. A single seed anywhere in the Lakes gave
  // Manchester to Yorkshire, and a single seed anywhere near Manchester gave Carlisle to
  // Scotland — both neighbours reach well into this region's box.
  // Lancashire first, because the first seed is also where the name is drawn and a label in the
  // Lakes collided with Southern Scotland's. It then sat 1.4° from Yorkshire's, which at this
  // screen's opening zoom is 50 px between two labels needing 57 — so Yorkshire was dropped
  // instead. Both were pulled apart to 1.7°; the seeds move together because they are the same
  // point.
  'north-west-england': [
    [-2.9, 53.75], // the Lancashire plain
    [-3.1, 54.6], // the Lakes
  ],
  yorkshire: [[-1.2, 53.95]], // Leeds and York
  'north-wales': [[-3.9, 52.95]], // Snowdonia
  'south-wales': [[-3.6, 51.8]], // the Brecon Beacons
  midlands: [[-1.6, 52.7]], // Birmingham and the Trent
  // Lincolnshire is in this region's *name*, and the Midlands box reaches east to Lincoln.
  'east-anglia': [
    [0.6, 52.5], // Norfolk and Suffolk
    [-0.4, 52.95], // Lincolnshire
  ],
  'south-west-england': [[-3.9, 50.7]], // Dartmoor and Exeter
  wessex: [[-1.7, 51.2]], // Salisbury Plain
  'london-home-counties': [[-0.15, 51.55]], // London
  'kent-sussex': [[0.4, 51.0]], // the Weald
}

/**
 * What a region is called on the map, when the map has no room for what it is called elsewhere.
 *
 * Fourteen names over Britain at z5 is more text than the island has room for, and MapLibre
 * resolves that by silently **dropping** the ones that collide — which took out Southern
 * Scotland, the North West, East Anglia, Wessex and Kent in the first pass, leaving five
 * unlabelled areas that a rider would have to tap to identify. Shorter names collide less, and
 * these are what a rider would say out loud anyway; the published name comes back as soon as the
 * zoom gives it room. Anything missing here falls back to the full name, which fits by
 * definition for a region whose name is already short.
 */
export const REGION_SHORT_NAMES: Record<string, string> = {
  'highlands-islands': 'Highlands',
  'southern-scotland': 'Southern Scotland',
  'central-scotland': 'Central Scotland',
  'north-east-england': 'North East',
  'north-west-england': 'North West',
  'south-west-england': 'South West',
  'east-anglia': 'East Anglia',
  'london-home-counties': 'London',
  'kent-sussex': 'Kent & Sussex',
  midlands: 'Midlands',
  wessex: 'Wessex',
}

/** An axis-aligned rectangle in degrees, as `[west, south, east, north]`. */
export type Rect = [number, number, number, number]

export interface RegionShape {
  id: string
  name: string
  /** {@link REGION_SHORT_NAMES}, or the full name where there is no shorter one. */
  short: string
  /** The region's share of the published coverage, as non-overlapping rectangles. */
  rects: Rect[]
  /** Only the edges where this region meets a different region, or the coverage ends. */
  edges: [number, number][][]
  /** Where the region's name is drawn: its first seed, always inside its own area. */
  anchor: [number, number]
}

/**
 * A region's seeds, or its box centre for one {@link REGION_SEEDS} has never heard of.
 *
 * The first is also where the name is drawn, so a region with several lists the one a rider
 * would read as its middle first.
 */
export function seedsFor(region: RegionEntry): [number, number][] {
  const seeds = REGION_SEEDS[region.id]
  if (seeds && seeds.length > 0) return seeds
  const [west, south, east, north] = region.bbox
  return [[(west + east) / 2, (south + north) / 2]]
}

const covers = ([west, south, east, north]: Rect, lon: number, lat: number): boolean =>
  lon >= west && lon <= east && lat >= south && lat <= north

/**
 * How far apart two points are, in degrees of latitude.
 *
 * Longitude is scaled by the cosine of the latitude, because a degree of longitude at 58°N is
 * barely half a degree of latitude on the ground — and an unscaled comparison would tilt every
 * north–south divide in Scotland. Squared, because only the ordering is ever used.
 */
export function spread(
  [aLon, aLat]: [number, number],
  [bLon, bLat]: [number, number],
): number {
  const scale = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180))
  const dLon = (aLon - bLon) * scale
  const dLat = aLat - bLat
  return dLon * dLon + dLat * dLat
}

/**
 * Which region a point belongs to, by the same rule the partition is drawn with.
 *
 * Nearest seed **among the regions whose published box covers it** — the clip is what keeps it
 * honest, since a seed can only redistribute published coverage and never invent it. `null` for
 * a point no published box covers, which is every place outside Great Britain and a rider who
 * has typed the name of a French town into the search.
 *
 * Exists because the search needs it: typing a place the phone has no map for is a dead end
 * unless the app can say *which region to download*, and that question is exactly "which region
 * would paint this point". Drawing the whole partition to answer it for one place would be
 * thirty-six thousand cells for a single town.
 */
export function regionAt(
  regions: RegionEntry[],
  lon: number,
  lat: number,
): RegionEntry | null {
  let best = Infinity
  let found: RegionEntry | null = null
  for (const region of regions) {
    if (!covers(region.bbox, lon, lat)) continue
    for (const seed of seedsFor(region)) {
      const distance = spread([lon, lat], seed)
      if (distance < best) {
        best = distance
        found = region
      }
    }
  }
  return found
}

/**
 * The partition, one shape per region, in the order the regions were given.
 *
 * A region always gets a shape — an empty one if some other box claims every cell it has, which
 * cannot happen while each region holds its own seed, but is not worth crashing over. Ties go to
 * the earlier region, so one manifest always draws one map.
 */
export function partitionRegions(regions: RegionEntry[]): RegionShape[] {
  if (regions.length === 0) return []

  const seeds = regions.map(seedsFor)
  const west = Math.min(...regions.map((r) => r.bbox[0]))
  const south = Math.min(...regions.map((r) => r.bbox[1]))
  const east = Math.max(...regions.map((r) => r.bbox[2]))
  const north = Math.max(...regions.map((r) => r.bbox[3]))

  const nx = Math.ceil((east - west) / CELL_DEGREES)
  const ny = Math.ceil((north - south) / CELL_DEGREES)

  // Owner index per cell, or -1 for a cell no region covers. Flat rather than nested: the edge
  // pass below reads every cell's four neighbours.
  const owner = new Int16Array(nx * ny).fill(-1)
  for (let j = 0; j < ny; j += 1) {
    const lat = south + (j + 0.5) * CELL_DEGREES
    for (let i = 0; i < nx; i += 1) {
      const lon = west + (i + 0.5) * CELL_DEGREES
      let best = Infinity
      let bestIndex = -1
      for (let r = 0; r < regions.length; r += 1) {
        if (!covers(regions[r].bbox, lon, lat)) continue
        for (const seed of seeds[r]) {
          const distance = spread([lon, lat], seed)
          if (distance < best) {
            best = distance
            bestIndex = r
          }
        }
      }
      owner[j * nx + i] = bestIndex
    }
  }

  const grid = { owner, nx, ny, west, south }
  return regions.map((region, index) => ({
    id: region.id,
    name: region.name,
    short: REGION_SHORT_NAMES[region.id] ?? region.name,
    rects: rectanglesFor(grid, index),
    edges: edgesFor(grid, index),
    anchor: seeds[index][0],
  }))
}

interface Grid {
  owner: Int16Array
  nx: number
  ny: number
  west: number
  south: number
}

const lonOf = (grid: Grid, i: number) => grid.west + i * CELL_DEGREES
const latOf = (grid: Grid, j: number) => grid.south + j * CELL_DEGREES

/**
 * The region's cells, merged greedily into maximal rectangles.
 *
 * Greedy rather than optimal: the minimum rectangular decomposition of a rectilinear polygon is
 * a maximum-matching problem, and the difference here is a handful of rectangles out of a few
 * dozen. What matters is that the count is small and that they tile the area exactly, which
 * greedy gives.
 *
 * Grow east first, then north while the whole width still matches. Growing north first would be
 * as correct and produces tall slivers along a coast.
 */
function rectanglesFor(grid: Grid, index: number): Rect[] {
  const { owner, nx, ny } = grid
  const taken = new Uint8Array(nx * ny)
  const rects: Rect[] = []

  const free = (i: number, j: number) => owner[j * nx + i] === index && !taken[j * nx + i]

  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!free(i, j)) continue

      let width = 1
      while (i + width < nx && free(i + width, j)) width += 1

      let height = 1
      grow: while (j + height < ny) {
        for (let k = 0; k < width; k += 1) {
          if (!free(i + k, j + height)) break grow
        }
        height += 1
      }

      for (let dj = 0; dj < height; dj += 1) {
        for (let di = 0; di < width; di += 1) taken[(j + dj) * nx + i + di] = 1
      }
      rects.push([lonOf(grid, i), latOf(grid, j), lonOf(grid, i + width), latOf(grid, j + height)])
    }
  }
  return rects
}

/**
 * The region's outline, as runs of cell edges.
 *
 * Deliberately *not* traced into closed rings. Tracing needs junction disambiguation wherever
 * two blocks touch at a corner, and nothing here wants a ring: the fill comes from the
 * rectangles above, and a line layer draws a MultiLineString of open runs exactly as well as it
 * draws a closed one. Collinear cells merge into a single run, so a straight divide is one
 * segment and a corner is the only place two runs meet.
 */
function edgesFor(grid: Grid, index: number): [number, number][][] {
  const { owner, nx, ny } = grid
  const at = (i: number, j: number) =>
    i < 0 || j < 0 || i >= nx || j >= ny ? -1 : owner[j * nx + i]

  const runs: [number, number][][] = []

  // The boundary between row j-1 and row j, swept west to east so a contiguous stretch
  // accumulates into one run. The extra step at each end closes a run that reaches the edge.
  for (let j = 0; j <= ny; j += 1) {
    let start = -1
    for (let i = 0; i <= nx; i += 1) {
      const isEdge = i < nx && (at(i, j) === index) !== (at(i, j - 1) === index)
      if (isEdge && start === -1) start = i
      if (!isEdge && start !== -1) {
        runs.push([
          [lonOf(grid, start), latOf(grid, j)],
          [lonOf(grid, i), latOf(grid, j)],
        ])
        start = -1
      }
    }
  }

  for (let i = 0; i <= nx; i += 1) {
    let start = -1
    for (let j = 0; j <= ny; j += 1) {
      const isEdge = j < ny && (at(i, j) === index) !== (at(i - 1, j) === index)
      if (isEdge && start === -1) start = j
      if (!isEdge && start !== -1) {
        runs.push([
          [lonOf(grid, i), latOf(grid, start)],
          [lonOf(grid, i), latOf(grid, j)],
        ])
        start = -1
      }
    }
  }

  return runs
}
