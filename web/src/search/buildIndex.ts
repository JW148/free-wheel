import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { PMTiles, type RangeResponse, type Source } from 'pmtiles'
import { packIndex, type PlaceCategory, type PlaceEntry, type PlaceIndex } from './placeIndex'

/**
 * Reading every name out of a basemap archive, once.
 *
 * This runs in the **engine Worker**, and that is not a performance choice. OPFS permits one
 * open sync access handle per file, the engine's registry owns every one of them, and
 * `CLAUDE.md` is explicit that nothing else may open one. So the archive is read where the
 * handles already are, through the same `readRangeFromOpfs` the map's tiles go through — with
 * the difference that here the reads are synchronous and there is no thread boundary to cross
 * 2,760 times.
 *
 * ## Why the deepest zoom, and only the deepest zoom
 *
 * Protomaps repeats a feature at every zoom from its own `min_zoom` upwards, so the archive's
 * maximum zoom carries *everything* — a village that first appears at z11 is in the z14 tile
 * too. One pass over that level is therefore a complete pass over the names, and any shallower
 * level would silently miss the streets, which is most of what a rider types.
 *
 * Measured on a laptop against `edinburgh.pmtiles`: 2,760 tiles, 21.6 MB, 285 ms, 51,038 named
 * features in, 34,927 entries out. A phone is a few times slower, so this is seconds rather
 * than minutes — and it happens once per region, after the download that took several minutes.
 *
 * ## Why names are clustered rather than deduplicated
 *
 * A road is cut into a segment per tile and every segment carries the name, so "Ferry Road"
 * arrives forty times. Collapsing by name alone would be wrong in the other direction: there
 * are 60 High Streets in the Central Belt and they are 60 different answers. So occurrences of
 * one name are grouped, and within a group they are clustered by distance — {@link CLUSTER_KM}
 * per category, because the right radius for a pub and the right radius for the A701 are not
 * the same number.
 */

/** Layers worth reading, and what a rider would call the things in them. */
const CATEGORY_OF_LAYER: Record<string, PlaceCategory> = {
  places: 'place',
  pois: 'poi',
  roads: 'road',
  water: 'water',
  // Named landmasses and islands. A handful per archive, and they are the only thing that
  // answers "Skye".
  earth: 'place',
}

/**
 * Road kinds nobody can ride to.
 *
 * `rail` is a main line, not a street — the same trap `NOT_PATHS_OR_RAIL` exists for in the
 * basemap style. Offering "East Coast Main Line" as a destination is offering to route onto it.
 */
const SKIP_ROAD_KINDS = new Set(['rail'])

/**
 * How far apart two occurrences of one name have to be to be two different places, in km.
 *
 * A road is the interesting number. Its segments run the length of it, so too small a radius
 * turns one street into a dozen results; too large merges the two ends of a trunk road into a
 * point in a field between them. 5 km puts a long A-road into a few results along its length,
 * which is both honest and useful — "the A701 near me" is a real thing to want.
 */
const CLUSTER_KM: Record<PlaceCategory, number> = { place: 2.2, poi: 0.7, road: 5, water: 5 }

/** Degrees of latitude per km, near enough at any British latitude. */
const KM_PER_DEGREE = 111.32

export interface IndexProgress {
  archive: string
  tilesDone: number
  tilesTotal: number
}

/**
 * A `pmtiles` Source over an already-open OPFS handle.
 *
 * Synchronous underneath and async by interface, because that is what `pmtiles` takes. No
 * handle is opened here: the caller has to have opened it, exactly as `mountBasemap` does for
 * the map, so this cannot become a second opener.
 */
class OpenHandleSource implements Source {
  // Written out rather than as parameter properties: `erasableSyntaxOnly` is on, and a
  // parameter property emits code rather than erasing.
  private readonly path: string
  private readonly read: (path: string, offset: number, length: number) => ArrayBuffer

  constructor(path: string, read: (path: string, offset: number, length: number) => ArrayBuffer) {
    this.path = path
    this.read = read
  }

  getKey(): string {
    return this.path
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.read(this.path, offset, length) }
  }
}

/**
 * Scans one archive and returns its packed index.
 *
 * `read` is injected so this is testable without OPFS, and so the one place that opens handles
 * stays the one place that opens handles.
 */
export async function buildPlaceIndex(
  path: string,
  archive: string,
  sourceBytes: number,
  read: (path: string, offset: number, length: number) => ArrayBuffer,
  onProgress?: (progress: IndexProgress) => void,
): Promise<PlaceIndex> {
  const pmtiles = new PMTiles(new OpenHandleSource(path, read))
  const header = await pmtiles.getHeader()
  const z = header.maxZoom

  const x0 = lonToTileX(header.minLon, z)
  const x1 = lonToTileX(header.maxLon, z)
  const y0 = latToTileY(header.maxLat, z)
  const y1 = latToTileY(header.minLat, z)
  const total = Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1))

  /** name + category + kind → the clusters found for it so far. */
  const groups = new Map<string, Cluster[]>()
  let done = 0

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      done++
      // A tile the extract does not cover. Most of the sea, and the corners of every bbox.
      const tile = await pmtiles.getZxy(z, x, y)
      if (tile) collectTile(groups, new Uint8Array(tile.data), z, x, y)
      // Once a row, not once a tile: 2,760 Comlink messages is more expensive than the scan.
      if (onProgress && done % 64 === 0) onProgress({ archive, tilesDone: done, tilesTotal: total })
    }
  }
  onProgress?.({ archive, tilesDone: total, tilesTotal: total })

  const entries: PlaceEntry[] = []
  for (const [key, clusters] of groups) {
    const { name, category, kind } = unkey(key)
    for (const cluster of clusters) {
      entries.push({ name, category, kind, lon: cluster.lon, lat: cluster.lat })
    }
  }

  return packIndex(archive, sourceBytes, entries)
}

interface Cluster {
  lon: number
  lat: number
  /** How many occurrences went into the running mean. */
  n: number
}

function collectTile(
  groups: Map<string, Cluster[]>,
  bytes: Uint8Array,
  z: number,
  x: number,
  y: number,
): void {
  /*
   * `@mapbox/vector-tile`'s types still describe pbf v3's combined reader/writer, while pbf v5
   * splits it into `PbfReader` and `PbfWriter`. The reader half is exactly what `VectorTile`
   * uses — the writer methods in the old type are never called on this path — so the cast is
   * the type declarations catching up rather than a claim about behaviour. Both packages are
   * already in the tree as maplibre's own dependencies, at the versions maplibre uses.
   */
  const tile = new VectorTile(new PbfReader(bytes) as never)

  for (const layerName of Object.keys(tile.layers)) {
    const category = CATEGORY_OF_LAYER[layerName]
    if (!category) continue
    const layer = tile.layers[layerName]

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i)
      const name = feature.properties.name
      if (typeof name !== 'string' || name.length === 0) continue
      const kind = typeof feature.properties.kind === 'string' ? feature.properties.kind : ''
      if (layerName === 'roads' && SKIP_ROAD_KINDS.has(kind)) continue

      const geometry = feature.loadGeometry()
      const ring = geometry[0]
      if (!ring || ring.length === 0) continue
      // The middle of the first ring rather than a centroid: for a road that is the middle of
      // the segment in this tile, for a polygon it is a point inside it, and for a point
      // feature it is the point. A true centroid can land outside a crescent-shaped park.
      const point = ring[Math.floor(ring.length / 2)]
      const lon = ((x + point.x / layer.extent) / 2 ** z) * 360 - 180
      const n = Math.PI - (2 * Math.PI * (y + point.y / layer.extent)) / 2 ** z
      const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue

      add(groups, key(name, category, kind), category, lon, lat)
    }
  }
}

/** Folds one occurrence into its nearest cluster, or starts a new one. */
function add(
  groups: Map<string, Cluster[]>,
  groupKey: string,
  category: PlaceCategory,
  lon: number,
  lat: number,
): void {
  let clusters = groups.get(groupKey)
  if (!clusters) groups.set(groupKey, (clusters = []))

  const radius = CLUSTER_KM[category] / KM_PER_DEGREE
  const shrink = Math.cos((lat * Math.PI) / 180)
  for (const cluster of clusters) {
    if (
      Math.abs(cluster.lat - lat) < radius &&
      Math.abs(cluster.lon - lon) * shrink < radius
    ) {
      // A running mean, so a road's reported position is the middle of it rather than whichever
      // tile happened to be scanned first.
      cluster.lon = (cluster.lon * cluster.n + lon) / (cluster.n + 1)
      cluster.lat = (cluster.lat * cluster.n + lat) / (cluster.n + 1)
      cluster.n++
      return
    }
  }
  clusters.push({ lon, lat, n: 1 })
}

/* A unit separator rather than a printable character: a name can contain anything, and a colon
   or a pipe in a street name would split the key in the wrong place. */
const SEP = String.fromCharCode(31)

const key = (name: string, category: PlaceCategory, kind: string) =>
  `${name}${SEP}${category}${SEP}${kind}`

function unkey(value: string): { name: string; category: PlaceCategory; kind: string } {
  const parts = value.split(SEP)
  return { name: parts[0], category: parts[1] as PlaceCategory, kind: parts[2] ?? '' }
}

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}

function latToTileY(lat: number, z: number): number {
  const radians = (lat * Math.PI) / 180
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** z,
  )
}
