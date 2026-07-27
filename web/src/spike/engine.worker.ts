/// <reference lib="webworker" />

import type {
  BackendId,
  BackendReport,
  BenchResult,
  CaseResult,
  JvmReference,
  ReferenceBenchmark,
  ReferenceCase,
  SpikeRequest,
} from './types'

/**
 * Spike 1's worker. Loads a TeaVM backend, replays the JVM reference corpus
 * through it, and times the two benchmark kernels.
 *
 * This is where the whole spike actually gets proven: the engine must run in a
 * Worker, because on iOS `createSyncAccessHandle()` has been Worker-only since
 * 15.2 and Phase 1's OPFS-backed VirtualFileSystem depends on it. Proving the
 * Wasm module loads on the main thread would prove the wrong thing.
 */

/** The @JSExport surface of btools.wasm.SpikeMain. */
interface Kernels {
  main?: (args: string[]) => void
  distance(lat1: number, lon1: number, lat2: number, lon2: number): number
  distanceBits(lat1: number, lon1: number, lat2: number, lon2: number): string
  heapBenchmark(n: number): number
  crcBenchmark(n: number): number
}

const asset = (baseUrl: string, path: string) => new URL(path, baseUrl).href

async function loadWasmGc(baseUrl: string): Promise<Kernels> {
  // TeaVM emits <name>.wasm plus a companion runtime. Built with
  // `modularRuntime = true`, so it is a real ES module exporting `load`.
  const runtime = await import(
    /* @vite-ignore */ asset(baseUrl, 'engine/wasm-gc/brouter-wasm.wasm-runtime.js')
  )
  const teavm = await runtime.load(asset(baseUrl, 'engine/wasm-gc/brouter-wasm.wasm'))
  return finishInit(teavm.exports as Kernels)
}

async function loadJs(baseUrl: string): Promise<Kernels> {
  // Built with moduleType = ES2015, so the exports are named directly.
  const module = await import(/* @vite-ignore */ asset(baseUrl, 'engine/js/brouter-wasm.js'))
  return finishInit(module as unknown as Kernels)
}

function finishInit(kernels: Kernels): Kernels {
  // Static initialisers (notably CheapRuler's 1800-entry scale cache) run lazily,
  // so main() is not strictly required — but running it keeps load timing honest
  // and matches how the real engine will be started.
  try {
    kernels.main?.([])
  } catch {
    // The JS backend's main() is a launcher expecting a callback; harmless either way.
  }
  return kernels
}

function runCase(kernels: Kernels, testCase: ReferenceCase): string {
  const [a, b, c, d] = testCase.args
  switch (testCase.kind) {
    case 'distanceBits':
      return kernels.distanceBits(a, b, c, d)
    case 'heapBenchmark':
      return String(kernels.heapBenchmark(a))
    case 'crcBenchmark':
      return String(kernels.crcBenchmark(a))
  }
}

/** Best-of-N wall time, after one discarded warmup — mirrors the JVM harness. */
function timeBenchmark(kernels: Kernels, benchmark: ReferenceBenchmark): BenchResult {
  const n = benchmark.args[0]
  const invoke = () =>
    benchmark.kind === 'heapBenchmark' ? kernels.heapBenchmark(n) : kernels.crcBenchmark(n)

  invoke()

  let bestMs = Number.POSITIVE_INFINITY
  for (let i = 0; i < benchmark.iterations; i++) {
    const t0 = performance.now()
    invoke()
    bestMs = Math.min(bestMs, performance.now() - t0)
  }

  return {
    id: benchmark.id,
    jvmBestMs: benchmark.jvmBestMs,
    backendBestMs: round(bestMs),
    slowdown: round(bestMs / benchmark.jvmBestMs),
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000

async function runBackend(
  backend: BackendId,
  reference: JvmReference,
  baseUrl: string,
): Promise<BackendReport> {
  const t0 = performance.now()
  const kernels = backend === 'wasm-gc' ? await loadWasmGc(baseUrl) : await loadJs(baseUrl)
  const loadMs = round(performance.now() - t0)

  const cases: CaseResult[] = reference.cases.map((testCase) => {
    const actual = runCase(kernels, testCase)
    return {
      id: testCase.id,
      note: testCase.note,
      expected: testCase.expected,
      actual,
      pass: actual === testCase.expected,
    }
  })

  const benchmarks = reference.benchmarks.map((b) => timeBenchmark(kernels, b))

  return { backend, ok: cases.every((c) => c.pass), loadMs, cases, benchmarks }
}

self.onmessage = async (event: MessageEvent<SpikeRequest>) => {
  const { backend, reference, baseUrl } = event.data
  try {
    self.postMessage(await runBackend(backend, reference, baseUrl))
  } catch (error) {
    const report: BackendReport = {
      backend,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      loadMs: 0,
      cases: [],
      benchmarks: [],
    }
    self.postMessage(report)
  }
}
