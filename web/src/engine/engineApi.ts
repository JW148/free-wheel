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
  deleteTile,
  importBasemapFile,
  importTileFile,
  installedBasemaps,
  installedTiles,
  resetTileStorage,
  SEGMENT_DIR,
  type ImportProgress,
} from './tileStore'
import type { ProvisionProgress } from './opfsVfs'
import type { RegionProgress } from './downloads'
import { downloadPlan } from '../data/regions'
import {
  completeRegionDownload,
  deleteRegionFiles,
  opfsDownloadDeps,
  readRecords,
  recordsAfterRemoval,
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

interface WasmEngine {
  Router: {
    route(profile: string, lonLats: string): string
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

  async deleteTile(tile: string) {
    await deleteTile(tile)
  },

  async resetTileStorage() {
    return resetTileStorage()
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
    return serializeRegionOp(async () => {
      const records = await readRecords()
      const plan = downloadPlan(region, manifest, records)

      await runRegionDownload(region.id, plan.items, plan.bytes, opfsDownloadDeps, onProgress)

      // Records the region, and only then forgets its download markers — see
      // `completeRegionDownload`, and `runRegionDownload`'s doc comment for why not sooner.
      const updated = await completeRegionDownload(region, manifest, plan.items, Date.now())

      // Opens the new .rd5 handles and registers /segments4. Do not remove — see the note above.
      await installedTiles()
      return updated
    })
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
  route(profile: string, lonLats: string): RouteOutcome {
    if (!engine) return { ok: false, error: 'engine not initialised', ms: 0 }

    const started = performance.now()
    let gpx: string
    try {
      gpx = engine.Router.route(profile, lonLats)
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
