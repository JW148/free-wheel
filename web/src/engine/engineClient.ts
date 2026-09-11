import * as Comlink from 'comlink'
import type { EngineApi, RouteOutcome } from './engineApi'
import type { ProvisionProgress } from './opfsVfs'
import type { ImportProgress } from './tileStore'
import type { RegionProgress } from './downloads'
import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'

/**
 * The one engine instance for the whole app.
 *
 * Not a convenience — a correctness requirement. Each `EngineClient` spawns its own Worker,
 * and each Worker opens its own OPFS sync access handles. OPFS allows exactly **one** open
 * handle per file, so a second engine fails with:
 *
 *     Access Handles cannot be created if there is another open Access Handle
 *     or Writable stream associated with the same file
 *
 * which is what happens the moment two components each construct a client. The engine is a
 * process-wide resource, like the virtual filesystem it installs, so it is shared like one.
 */
let shared: EngineClient | null = null

export function sharedEngine(): EngineClient {
  return (shared ??= new EngineClient())
}

/**
 * Main-thread handle on the engine Worker.
 *
 * Owns the Worker's lifecycle, because that is what cancellation costs here: a route already
 * running cannot be interrupted cooperatively (see the note in `engineApi.ts`), so `cancel()`
 * kills the Worker outright. The next call transparently spawns and re-initialises a new one.
 * Data in OPFS is untouched by that, so the price is re-opening handles, not re-downloading.
 */
export class EngineClient {
  private worker: Worker | null = null
  private api: Comlink.Remote<EngineApi> | null = null
  private ready: Promise<void> | null = null
  private readonly baseUrl: string

  // Written out rather than using a parameter property: `erasableSyntaxOnly` is on, and
  // parameter properties emit code rather than erasing.
  constructor(baseUrl: string = document.baseURI) {
    this.baseUrl = baseUrl
  }

  private spawn(): Comlink.Remote<EngineApi> {
    if (this.api) return this.api
    this.worker = new Worker(new URL('./engineApi.ts', import.meta.url), { type: 'module' })
    this.api = Comlink.wrap<EngineApi>(this.worker)
    return this.api
  }

  /** Loads the engine and mounts OPFS. Repeated calls share one in-flight initialisation. */
  async init(onProgress?: (progress: ProvisionProgress) => void): Promise<void> {
    const api = this.spawn()
    this.ready ??= api
      .init(this.baseUrl, onProgress ? Comlink.proxy(onProgress) : undefined)
      .then(() => undefined)
    return this.ready
  }

  async installedTiles() {
    await this.init()
    return this.spawn().installedTiles()
  }

  async importTiles(files: File[], onProgress?: (progress: ImportProgress) => void) {
    await this.init()
    return this.spawn().importTiles(files, onProgress ? Comlink.proxy(onProgress) : undefined)
  }

  async importBasemaps(files: File[], onProgress?: (progress: ImportProgress) => void) {
    await this.init()
    return this.spawn().importBasemaps(files, onProgress ? Comlink.proxy(onProgress) : undefined)
  }

  async installedBasemaps() {
    await this.init()
    return this.spawn().installedBasemaps()
  }

  /**
   * Downloads a region, reporting progress as it goes.
   *
   * `onProgress` has to cross into the Worker, and a plain function does not survive
   * structured cloning — `Comlink.proxy` is what turns it into something callable from the
   * other side. Forgetting it is not a type error, it is a `DataCloneError` at the moment the
   * download starts, which is the least convenient moment to find out.
   */
  async downloadRegion(
    region: RegionEntry,
    manifest: DataManifest,
    onProgress?: (progress: RegionProgress) => void,
  ): Promise<InstalledRegion[]> {
    await this.init()
    return this.spawn().downloadRegion(region, manifest, onProgress ? Comlink.proxy(onProgress) : undefined)
  }

  async installedRegions(): Promise<InstalledRegion[]> {
    await this.init()
    return this.spawn().installedRegions()
  }

  async deleteTile(tile: string) {
    await this.init()
    return this.spawn().deleteTile(tile)
  }

  async resetTileStorage() {
    await this.init()
    return this.spawn().resetTileStorage()
  }

  async readRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    await this.init()
    return this.spawn().readRange(path, offset, length)
  }

  /** Opens a file so later range reads can be synchronous inside the worker. */
  async openForReading(path: string): Promise<number> {
    await this.init()
    return this.spawn().openForReading(path)
  }

  async route(profile: string, lonLats: string): Promise<RouteOutcome> {
    await this.init()
    return this.spawn().route(profile, lonLats)
  }

  async diagnostics() {
    await this.init()
    return this.spawn().diagnostics()
  }

  /**
   * Stops whatever is running, by terminating the Worker.
   *
   * Blunt, and deliberately so: during `doRun` the Worker is blocked inside Wasm and will not
   * process a message, so there is no gentler option without a `SharedArrayBuffer` flag and
   * the COOP/COEP headers it requires.
   */
  cancel(): void {
    this.worker?.terminate()
    this.worker = null
    this.api = null
    this.ready = null
  }
}
