/**
 * BRouter segment-tile geometry.
 *
 * Tiles are a 5°×5° grid named by their **south-west corner**: `W5_N50` covers longitude
 * −5…0 and latitude 50…55. Longitude runs `W180`…`E175`, latitude `S90`…`N80` — note the
 * asymmetry, which is why the east and north edges are one cell short of 180/90.
 *
 * Pure functions, no I/O. The catalogue (sizes) and the downloader live elsewhere.
 */

export const TILE_DEGREES = 5

/** Longitude/latitude of a tile's south-west corner. */
export interface TileOrigin {
  lon: number
  lat: number
}

export interface Bbox {
  west: number
  south: number
  east: number
  north: number
}

/** Snaps a coordinate down to its tile origin. Uses floor, so it is correct for negatives. */
const originOf = (degrees: number) => Math.floor(degrees / TILE_DEGREES) * TILE_DEGREES

/** `-5, 50` → `W5_N50`. Note `E0`/`N0` — zero is treated as positive, matching upstream. */
export function tileName(lon: number, lat: number): string {
  const lonOrigin = originOf(lon)
  const latOrigin = originOf(lat)
  const ew = lonOrigin < 0 ? `W${-lonOrigin}` : `E${lonOrigin}`
  const ns = latOrigin < 0 ? `S${-latOrigin}` : `N${latOrigin}`
  return `${ew}_${ns}`
}

/** Inverse of {@link tileName}. Returns null if the name is not a tile. */
export function parseTileName(name: string): TileOrigin | null {
  const match = /^([EW])(\d{1,3})_([NS])(\d{1,2})$/.exec(name)
  if (!match) return null
  const lon = (match[1] === 'W' ? -1 : 1) * Number(match[2])
  const lat = (match[3] === 'S' ? -1 : 1) * Number(match[4])
  if (lon % TILE_DEGREES !== 0 || lat % TILE_DEGREES !== 0) return null
  return { lon, lat }
}

export function tileBounds(name: string): Bbox | null {
  const origin = parseTileName(name)
  if (!origin) return null
  return {
    west: origin.lon,
    south: origin.lat,
    east: origin.lon + TILE_DEGREES,
    north: origin.lat + TILE_DEGREES,
  }
}

/**
 * Every tile a bounding box touches.
 *
 * Handles a box that crosses the antimeridian (`west > east`) by splitting it, which is the
 * case a naive min/max loop silently gets wrong — it would otherwise select the entire globe
 * the long way round.
 */
export function tilesForBbox(bbox: Bbox): string[] {
  const { south, north } = bbox
  const spans: [number, number][] =
    bbox.west <= bbox.east
      ? [[bbox.west, bbox.east]]
      : [
          [bbox.west, 180],
          [-180, bbox.east],
        ]

  const names: string[] = []
  for (const [west, east] of spans) {
    for (let lon = originOf(west); lon < east; lon += TILE_DEGREES) {
      for (let lat = originOf(south); lat < north; lat += TILE_DEGREES) {
        // Clamp rather than skip: latitudes beyond the grid have no tiles, but a bbox that
        // merely touches the pole should still yield the tiles it legitimately covers.
        if (lat < -90 || lat > 80 || lon < -180 || lon > 175) continue
        names.push(tileName(lon, lat))
      }
    }
  }
  return [...new Set(names)].sort()
}

/** The tiles a route's waypoints fall in — the minimum set needed to plan it. */
export function tilesForWaypoints(points: { lon: number; lat: number }[]): string[] {
  return [...new Set(points.map((p) => tileName(p.lon, p.lat)))].sort()
}

// ---------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------

export interface TileCatalogue {
  source: string
  generated: string
  tileCount: number
  totalBytes: number
  medianBytes: number
  largestBytes: number
  tiles: Record<string, { bytes: number; modified: string }>
}

export interface RegionEstimate {
  /** Tiles that exist in the catalogue — ocean-only cells simply have no tile. */
  tiles: string[]
  /** Names selected by geometry that the catalogue does not list. */
  missing: string[]
  bytes: number
}

/**
 * Sizes a region, dropping tiles that do not exist.
 *
 * Most of the grid is ocean and has no tile at all, so geometry alone over-selects badly —
 * a bbox around Britain includes cells that are entirely sea.
 */
export function estimateRegion(catalogue: TileCatalogue, names: string[]): RegionEstimate {
  const tiles: string[] = []
  const missing: string[] = []
  let bytes = 0

  for (const name of names) {
    const entry = catalogue.tiles[name]
    if (entry) {
      tiles.push(name)
      bytes += entry.bytes
    } else {
      missing.push(name)
    }
  }
  return { tiles, missing, bytes }
}

/**
 * Preset regions. Sizes are always computed from the catalogue, never hard-coded — the whole
 * point is that the picker quotes the truth.
 *
 * A caution the grid imposes on any UI built here: coverage is quantised to 5°, so a tile is
 * either wholly in or wholly out. Extending a region by a few kilometres can cost hundreds of
 * megabytes. The clearest example is Britain's south coast — the Lizard sits at 49.96 °N, so
 * covering it pulls in the N45 row, which also contains northern France and Brittany at about
 * +190 MB. That is why `great-britain` and `britain-full` are offered separately rather than
 * quietly rounding one into the other.
 */
export const REGIONS: { id: string; label: string; note: string; bbox: Bbox }[] = [
  {
    id: 'london',
    label: 'London and the South East',
    note: 'Smallest useful region for testing',
    bbox: { west: -1, south: 50.5, east: 1, north: 52 },
  },
  {
    id: 'great-britain',
    label: 'Great Britain',
    note: 'Clips the Lizard (49.96°N) and Shetland to avoid two costly rows',
    bbox: { west: -8, south: 50, east: 2, north: 59 },
  },
  {
    id: 'uk-ireland',
    label: 'UK and Ireland, incl. Shetland',
    note: 'Adds the far north for very little — those tiles are mostly sea',
    bbox: { west: -11, south: 50, east: 2, north: 61 },
  },
  {
    id: 'britain-full',
    label: 'UK, Ireland and the Channel',
    note: 'Adds the N45 row for Cornwall — which also brings northern France',
    bbox: { west: -11, south: 49.5, east: 2, north: 61 },
  },
  {
    id: 'france',
    label: 'France',
    note: '',
    bbox: { west: -5, south: 42, east: 8, north: 51 },
  },
]

export const formatBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`
