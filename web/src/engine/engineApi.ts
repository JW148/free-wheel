/// <reference lib="webworker" />

import * as Comlink from 'comlink'
import {
  installVfsBridge,
  openHandle,
  provisionOpfs,
  provisionedFiles,
  readRangeFromOpfs,
} from './opfsVfs'
import {
  deleteBasemapFile,
  importBasemapFile,
  importTileFile,
  installedBasemaps,
  installedTiles,
  BASEMAP_DIR,
  SEGMENT_DIR,
  type ImportProgress,
} from './tileStore'
import { buildPlaceIndex, type IndexProgress } from '../search/buildIndex'
import type { ProvisionProgress } from './opfsVfs'
import type { RegionProgress } from './downloads'
import { downloadPlan } from '../data/regions'
import {
  completeRegionDownload,
  deleteRegionFiles,
  deleteTileSerialized,
  opfsDownloadDeps,
  readRecords,
  recordsAfterRemoval,
  resetTileStorageSerialized,
  runRegionDownload,
  serializeRegionOp,
  writeRecords,
} from './regionStore'
// `import type` is load-bearing here: this file runs in a Worker, which has no `localStorage`,
// and `manifest.ts` contains `loadManifest`, which uses it. A value import would pull that
// code into the Worker bundle even though nothing here calls it.
import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'

/**
 * The engine's Worker-side API, exposed over Comlink.
 *
 * Everything runs here rather than on the main thread because `createSyncAccessHandle()` is
 * Worker-only on iOS, and the whole synchronous-VFS design depends on it.
 *
 * ## On cancellation
 *
 * The plan calls for "cancellation via `RoutingEngine.terminate()`". That is not reachable
 * from here. `terminate()` is *cooperative*: it sets a `volatile boolean` polled at six
 * points in the search, so some other thread has to call it while `doRun` runs. A Worker is
 * single-threaded, and during `doRun` it is blocked inside Wasm and will not process an
 * incoming message — so `terminate()` can never be delivered in time.
 *
 * Two options remain, and the client uses both:
 *
 * - **`maxRunningTime`** bounds a run from the inside (BRouter checks it itself).
 * - **Terminating the Worker** is the only way to stop a run already in progress. That
 *   discards the Wasm instance and every OPFS handle, so the client re-initialises
 *   afterwards. Data already in OPFS survives, so the cost is re-opening handles, not
 *   re-downloading.
 *
 * A cooperative in-flight cancel would need a `SharedArrayBuffer` flag polled by patched
 * BRouter code, which in turn needs COOP/COEP headers. Not worth it until it is.
 */

/** Shipped cycling profiles, copied into OPFS on first run. */
const PROFILES = [
  'trekking.brf',
  'fastbike.brf',
  'fastbike-verylowtraffic.brf',
  'gravel.brf',
  'mtb.brf',
  'shortest.brf',
  'lookups.dat',
]

/**
 * BRouter's GPX output mode, and the reason the app never asks for the plain one.
 *
 * Mode 9 is the only mode `FormatGpx` emits both of the things this app reads: a
 * `<brouter:voicehint>` at each junction, which is turn-by-turn, and a `<brouter:way>` at each
 * change of road tags, which is the surface, the road class and whether the way is on the
 * National Cycle Network. Both are computed on every route regardless — BRouter's second,
 * guide-track pass builds them — so this asks for data already in hand rather than for more
 * work. Mode 0 is still reachable through `Router.route` and the parity corpus runs both.
 */
export const TURN_INSTRUCTION_MODE = 9

interface WasmEngine {
  Router: {
    route(profile: string, lonLats: string, turnInstructionMode: number): string
    crc32Utf8(text: string): number
    utf8Length(text: string): number
  }
  OpfsVirtualFileSystem: { installOpfsVfs(): string }
  VfsProbe: {
    probeRead(path: string): string
    probeList(path: string): string
    probeDepth(depth: number): number
  }
}

let engine: WasmEngine | null = null

async function loadEngine(baseUrl: string): Promise<WasmEngine> {
  if (engine) return engine
  const url = (path: string) => new URL(path, baseUrl).href
  const runtime = await import(
    /* @vite-ignore */ url('engine/wasm-gc/brouter-wasm.wasm-runtime.js')
  )
  const teavm = await runtime.load(url('engine/wasm-gc/brouter-wasm.wasm'))
  engine = teavm.exports as WasmEngine
  return engine
}

export interface RouteOutcome {
  ok: boolean
  /** GPX on success, absent on failure. */
  gpx?: string
  error?: string
  ms: number
  gpxLength?: number
  gpxCrc32?: number
}

/**
 * In-flight (and queued) region downloads, so one can be called off from the main thread.
 *
 * Module-level rather than threaded through `downloadRegion`, because the cancel arrives as a
 * *separate* Comlink call: the two have nothing in common except the region id.
 */
const downloadAborts = new Map<string, AbortController>()

/**
 * The rejection a cancelled download ends with.
 *
 * `AbortError` by name, because that is what the rest of the platform uses and what the
 * download store checks for — the difference between "you stopped this" and "this broke" is
 * the whole of what the screen says next.
 */
const cancelled = () => new DOMException('download cancelled', 'AbortError')

const engineApi = {
  /**
   * Loads the Wasm module, copies the bundled profiles into OPFS, and installs the VFS.
   * Idempotent — safe to call again after the worker has been recreated by a cancel.
   */
  async init(
    baseUrl: string,
    onProgress?: (progress: ProvisionProgress) => void,
  ): Promise<{ files: { path: string; size: number }[] }> {
    const wasm = await loadEngine(baseUrl)

    await provisionOpfs(
      PROFILES.map((name) => ({
        path: `/profiles2/${name}`,
        url: new URL(`profiles2/${name}`, baseUrl).href,
      })),
      onProgress,
    )
    installVfsBridge()

    const installed = wasm.OpfsVirtualFileSystem.installOpfsVfs()
    if (installed !== 'ok') throw new Error(`could not install the VFS: ${installed}`)

    // Open the imported tiles here, not somewhere in the UI.
    //
    // Two things depend on it, and both are invisible until a route is attempted. Reads are
    // synchronous, so every `.rd5` handle must already be open — a sync `read()` can never
    // open one. And the VFS's directory registry is in-memory, populated as files are opened,
    // so without this `/segments4` simply is not known to exist and BRouter fails with
    // "segment directory /segments4 does not exist" while the files sit there in OPFS.
    //
    // This used to happen by accident: `TilesPanel` called `installedTiles()` on mount, and it
    // mounted on every page load. Once it moved behind Setup, a cold start that went straight
    // to routing never opened anything — which is exactly the ride-day path (plan at home,
    // reopen on the bike, reroute). The engine must not depend on a component having mounted.
    await installedTiles()

    return { files: provisionedFiles() }
  },

  async installedTiles() {
    return installedTiles()
  },

  /**
   * Imports user-supplied `.rd5` files — the escape hatch beside the region download.
   *
   * `File` survives structured cloning, so the picker can live on the main thread while the
   * OPFS writing stays here, where sync access handles exist.
   */
  async importTiles(files: File[], onProgress?: (progress: ImportProgress) => void) {
    const imported: string[] = []
    const failed: { name: string; error: string }[] = []
    for (const file of files) {
      try {
        imported.push(await importTileFile(file, onProgress))
      } catch (error) {
        failed.push({ name: file.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported, failed }
  },

  async importBasemaps(files: File[], onProgress?: (progress: ImportProgress) => void) {
    const imported: string[] = []
    const failed: { name: string; error: string }[] = []
    for (const file of files) {
      try {
        imported.push(await importBasemapFile(file, onProgress))
      } catch (error) {
        failed.push({ name: file.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported, failed }
  },

  async installedBasemaps() {
    return installedBasemaps()
  },

  /**
   * Reads every name out of one basemap archive, for the offline place search.
   *
   * Here rather than on the main thread for the reason everything about OPFS is here: exactly
   * one sync access handle may be open per file and this registry owns it, so a second opener
   * on the main thread would collide with the map. `openHandle` is idempotent — `mountBasemap`
   * has usually opened this file already — and the reads underneath are synchronous, which is
   * the difference between one pass over the archive and 2,760 round trips across a thread
   * boundary.
   *
   * It blocks this Worker while it runs, like a route does, for a few seconds per region. The
   * caller is responsible for not asking during a ride; see `searchStore.hold`.
   *
   * The three typed arrays are transferred rather than copied. They are the bulk of the result —
   * about 0.4 MB for a region — and nothing here keeps them afterwards.
   */
  async buildPlaceIndex(name: string, onProgress?: (progress: IndexProgress) => void) {
    const path = `${BASEMAP_DIR}/${name}`
    const handle = await openHandle(path)
    const index = await buildPlaceIndex(path, name, handle.getSize(), readRangeFromOpfs, onProgress)
    return Comlink.transfer(index, [index.kinds.buffer, index.lons.buffer, index.lats.buffer])
  },

  /**
   * Deletes one hand-imported map archive.
   *
   * Serialized like every other deletion, and reading `regions.json` inside the queue so the
   * "does a region own this?" check cannot be answered from a snapshot a download is in the
   * middle of replacing.
   */
  async deleteBasemap(name: string) {
    return serializeRegionOp(async () => {
      const records = await readRecords()
      await deleteBasemapFile(
        name,
        records.map((record) => record.id),
      )
    })
  },

  /**
   * Deletes one segment.
   *
   * Serialized against `downloadRegion` and `removeRegion`, because it retracts the segment's
   * hash from `/regions.json` and a download committing across it would put the retraction
   * straight back. See `regionStore.deleteTileSerialized` for why the wrap lives there and not
   * in `tileStore`.
   */
  async deleteTile(tile: string) {
    await deleteTileSerialized(tile)
  },

  /** Clears every segment, serialized for the same reason as {@link deleteTile}. */
  async resetTileStorage() {
    return resetTileStorageSerialized()
  },

  /**
   * Downloads a region's basemap and routing segments into OPFS.
   *
   * Runs here because sync access handles are Worker-only on iOS, and finishes by calling
   * `installedTiles()` again: that call is what registers `/segments4` in the VFS's in-memory
   * directory registry, and skipping it makes BRouter report that the segment directory does
   * not exist while the file sits in OPFS. It only shows up on a cold start.
   *
   * The per-item resume/restart/skip loop lives in `regionStore.runRegionDownload`, tested there
   * without OPFS — this is thin wiring around it plus the bookkeeping that has to happen once
   * for the whole region: reading and writing `regions.json`, and only then clearing the
   * download markers `runRegionDownload` deliberately leaves behind (see its doc comment).
   *
   * The whole call is serialized through `serializeRegionOp` against every other
   * `downloadRegion`/`removeRegion` call.
   */
  async downloadRegion(
    region: RegionEntry,
    manifest: DataManifest,
    onProgress?: (progress: RegionProgress) => void,
  ): Promise<InstalledRegion[]> {
    // Registered *before* entering the queue, not inside it. A rider who taps three regions
    // and then changes their mind about the third is cancelling something that has not started
    // — it is sitting behind two others in `serializeRegionOp` — and a controller created
    // inside the queued body would not exist yet to be aborted.
    const controller = new AbortController()
    downloadAborts.get(region.id)?.abort(cancelled())
    downloadAborts.set(region.id, controller)
    try {
      return await serializeRegionOp(async () => {
        controller.signal.throwIfAborted()
        const records = await readRecords()
        const plan = downloadPlan(region, manifest, records)

        await runRegionDownload(
          region.id,
          plan.items,
          plan.bytes,
          opfsDownloadDeps,
          onProgress,
          controller.signal,
        )

        // Records the region, and only then forgets its download markers — see
        // `completeRegionDownload`, and `runRegionDownload`'s doc comment for why not sooner.
        const updated = await completeRegionDownload(region, manifest, plan.items, Date.now())

        // Opens the new .rd5 handles and registers /segments4. Do not remove — see the note above.
        await installedTiles()
        return updated
      })
    } finally {
      // Only if it is still ours: a second `downloadRegion` for the same id has already
      // replaced the entry, and deleting it here would leave that one uncancellable.
      if (downloadAborts.get(region.id) === controller) downloadAborts.delete(region.id)
    }
  },

  /**
   * Stops a download, whether it is running or still queued behind another.
   *
   * Deliverable in a way `RoutingEngine.terminate()` is not, and for a reason worth writing
   * down: a download spends its time awaiting network and OPFS, so the Worker's event loop is
   * free and a Comlink message actually arrives. A route spends its time blocked inside Wasm,
   * where nothing is delivered until it returns — which is why the cancel note at the top of
   * this file says the only way to stop *that* is to terminate the Worker.
   *
   * Bytes already written are kept. The partial marker on disk describes them, so the next
   * attempt resumes from where this one stopped rather than starting again.
   */
  async cancelRegionDownload(id: string) {
    downloadAborts.get(id)?.abort(cancelled())
  },

  async installedRegions(): Promise<InstalledRegion[]> {
    return readRecords()
  },

  /**
   * Removes a region: writes the record first, deletes files second.
   *
   * That order matters. `removeFile` swallows `NotFoundError` but not
   * `NoModificationAllowedError` — a real scenario when a second Safari tab holds a lock — so a
   * partial failure has to leave orphaned bytes with no record (self-healed by the next
   * download) rather than a record for a region whose basemap is already gone and which
   * `downloadPlan` would then refuse to ever re-fetch.
   */
  async removeRegion(id: string): Promise<InstalledRegion[]> {
    return serializeRegionOp(async () => {
      const records = await readRecords()
      const { records: remaining, deleteSegments, deleteBasemap } = recordsAfterRemoval(records, id)
      await writeRecords(remaining)
      await deleteRegionFiles(deleteSegments, deleteBasemap)
      return remaining
    })
  },

  /**
   * Reads a byte range out of an OPFS file.
   *
   * This is what makes a PMTiles basemap possible. PMTiles is a single archive read by byte
   * range, and MapLibre's protocol handler runs on the main thread — where OPFS sync access
   * handles do not exist on iOS. So the range read happens here and the bytes are transferred
   * back; the handler is async, so nothing is lost by the round trip.
   *
   * Returned via Comlink.transfer so the buffer is moved rather than copied — tile reads are
   * frequent enough that copying every one would be wasteful.
   */
  /** Opens a file and returns its size, so the caller knows the archive length up front. */
  async openForReading(path: string): Promise<number> {
    const handle = await openHandle(path)
    return handle.getSize()
  },

  readRange(path: string, offset: number, length: number) {
    const buffer = readRangeFromOpfs(path, offset, length)
    return Comlink.transfer(buffer, [buffer])
  },

  /**
   * Routes, returning the GPX plus its length and CRC-32.
   *
   * Blocks this Worker for the duration — see the cancellation note above. Errors come back
   * as data rather than exceptions so a JS-level throw out of Wasm (a stack `RangeError`,
   * which Java cannot catch) is reported rather than lost.
   */
  route(
    profile: string,
    lonLats: string,
    turnInstructionMode: number = TURN_INSTRUCTION_MODE,
  ): RouteOutcome {
    if (!engine) return { ok: false, error: 'engine not initialised', ms: 0 }

    const started = performance.now()
    let gpx: string
    try {
      gpx = engine.Router.route(profile, lonLats, turnInstructionMode)
    } catch (error) {
      return {
        ok: false,
        ms: Math.round((performance.now() - started) * 10) / 10,
        error: `escaped to JS — ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const ms = Math.round((performance.now() - started) * 10) / 10

    if (gpx.startsWith('error:')) return { ok: false, error: gpx.slice(6), ms }

    return {
      ok: true,
      gpx,
      ms,
      gpxLength: engine.Router.utf8Length(gpx),
      gpxCrc32: engine.Router.crc32Utf8(gpx),
    }
  },

  /** Diagnostics, kept because they were what made Phase 1's failures findable. */
  diagnostics(): { vfsList: string; profile: string; lookups: string; maxDepth: number } {
    if (!engine) throw new Error('engine not initialised')
    return {
      vfsList: engine.VfsProbe.probeList('/profiles2'),
      profile: engine.VfsProbe.probeRead('/profiles2/trekking.brf'),
      lookups: engine.VfsProbe.probeRead(`${SEGMENT_DIR}/../profiles2/lookups.dat`),
      maxDepth: measureMaxDepth(engine),
    }
  },
}

/**
 * Deepest Java recursion this runtime survives.
 *
 * Must be measured from JS: stack exhaustion on WasmGC is a JS `RangeError` that Java cannot
 * catch. Treat the result as an **upper bound only** — the probe's frame is nearly empty,
 * whereas real recursive code carries locals, and capacity is bytes rather than frames. On
 * device this reported 25,179 while the real `minVisitIdInSubtree` overflowed past 2,000.
 */
function measureMaxDepth(wasm: WasmEngine): number {
  const survives = (depth: number) => {
    try {
      wasm.VfsProbe.probeDepth(depth)
      return true
    } catch {
      return false
    }
  }
  if (!survives(1)) return 0

  let low = 1
  let high = 1
  while (high < 1_000_000 && survives(high)) {
    low = high
    high *= 2
  }
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (survives(mid)) low = mid
    else high = mid
  }
  return low
}

export type EngineApi = typeof engineApi

Comlink.expose(engineApi)
