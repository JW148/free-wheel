import { addProtocol } from 'maplibre-gl'
import { PMTiles, Protocol, type RangeResponse, type Source } from 'pmtiles'
import { sharedEngine } from '../engine/engineClient'

/**
 * A PMTiles basemap read out of OPFS.
 *
 * PMTiles is a single archive addressed by byte range, which is exactly what OPFS is good at
 * and exactly why there is no tile server in this design.
 *
 * ## Why not `@makina-corpus/maplibre-offline-pmtiles`
 *
 * The plan suggested vendoring it. Reading what it does, it opens its **own** OPFS handles —
 * and OPFS permits only one open sync access handle per file. The engine already owns a
 * handle registry, so a second opener would collide exactly as two Workers did during
 * Phase 2:
 *
 *     Access Handles cannot be created if there is another open Access Handle
 *
 * Implementing `pmtiles`' own `Source` interface against the existing registry is both
 * smaller and avoids the conflict entirely.
 *
 * ## Why the reads cross a thread boundary
 *
 * Sync access handles are Worker-only on iOS, but MapLibre's protocol handler runs on the
 * main thread. Since that handler is asynchronous anyway, the range read is delegated to the
 * engine Worker and the bytes are transferred back — no copy, and no need for OPFS on the
 * main thread at all.
 */

/** Where basemap archives live inside OPFS. */
export const BASEMAP_DIR = '/basemap'

/** Call counts and the last error, so a stalled map can be told from an idle one. */
export const sourceStats = {
  reads: 0,
  bytes: 0,
  lastError: null as string | null,
  requests: [] as string[],
}

class OpfsPmtilesSource implements Source {
  private readonly path: string
  private readonly key: string

  constructor(name: string) {
    this.path = `${BASEMAP_DIR}/${name}`
    this.key = name
  }

  getKey(): string {
    return this.key
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    try {
      const data = await sharedEngine().readRange(this.path, offset, length)
      sourceStats.reads += 1
      sourceStats.bytes += data.byteLength
      return { data }
    } catch (error) {
      // Surfaced rather than swallowed: pmtiles falls back to constructing a FetchSource
      // when a key is unknown, so a silent failure here reappears later as a mysterious
      // network request for a file that only exists in OPFS.
      sourceStats.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
}

let protocol: Protocol | null = null

/**
 * Registers the `pmtiles://` protocol.
 *
 * `addProtocol` is **global to the module, not per-map**, and must run before any
 * `Map` is constructed — a map created first will simply fail to resolve the scheme. Hence a
 * module-level call guarded against double registration rather than an effect inside a
 * component.
 */
export function registerPmtilesProtocol(): Protocol {
  if (protocol) return protocol
  // metadata: true makes Protocol return a complete TileJSON — `tilejson`, `vector_layers`,
  // attribution, center — by reading the archive's metadata section. With it false the
  // response carries only tiles/zoom/bounds, which MapLibre accepted without complaint but
  // never progressed past. Costs one extra range read, once per archive.
  const created = new Protocol({ metadata: true })

  // Wrapped rather than passed straight through, so protocol traffic is visible. pmtiles
  // silently substitutes a network-backed FetchSource when it does not recognise a key,
  // which turns a wiring mistake into a mysterious hang instead of an error.
  addProtocol('pmtiles', async (params, abortController) => {
    const label = `${params.type ?? '?'} ${params.url}`
    sourceStats.requests.push(`${label} …`)
    try {
      const result = await created.tile(params, abortController)
      sourceStats.requests.push(`${label} ✓`)
      return result
    } catch (error) {
      sourceStats.lastError = `${params.url}: ${error instanceof Error ? error.message : String(error)}`
      sourceStats.requests.push(`${label} ✗`)
      throw error
    }
  })

  protocol = created
  return protocol
}

/**
 * Makes an OPFS archive available to the map as `pmtiles://<name>`.
 *
 * @param name file name inside {@link BASEMAP_DIR}, e.g. `london.pmtiles`
 * @returns the archive header, which carries the zoom range and bounds the style needs
 */
export async function mountBasemap(name: string) {
  const registered = registerPmtilesProtocol()

  // Open it in the Worker first: range reads there are synchronous and cannot open a file
  // themselves, so the handle has to exist before the first tile request arrives.
  const bytes = await sharedEngine().openForReading(`${BASEMAP_DIR}/${name}`)
  if (bytes === 0) {
    throw new Error(`${name} is empty — import a .pmtiles archive first`)
  }

  const archive = new PMTiles(new OpfsPmtilesSource(name))
  registered.add(archive)

  const header = await archive.getHeader()
  return {
    name,
    bytes,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat] as [
      number,
      number,
      number,
      number,
    ],
    center: [header.centerLon, header.centerLat] as [number, number],
  }
}

/**
 * Makes a remote archive available to the map, read by HTTP range.
 *
 * Nothing is downloaded. The region picker shows Britain at z5 to z8 and pulls a few hundred
 * kilobytes out of a 61 MB archive, which is why the first screen does not have to wait for a
 * download to show a real map.
 */
export async function mountRemoteBasemap(url: string): Promise<{ maxZoom: number }> {
  registerPmtilesProtocol()
  const archive = new PMTiles(url)
  const header = await archive.getHeader()
  // Only the max zoom, because only the max zoom is used: the picker opens at a fixed centre
  // and zoom of its own, and the archive is streamed rather than stored, so it has no size
  // or name worth reporting. `mountBasemap` above is the one that describes a local archive.
  return { maxZoom: header.maxZoom }
}
