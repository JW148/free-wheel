import type { BackendId, BackendReport, JvmReference, SpikeRequest } from './types'

/**
 * Runs one backend in a fresh Worker and resolves with its report.
 *
 * A fresh Worker per backend on purpose: WasmGC and the JS fallback both define
 * the same global class metadata, and reusing a worker would let the first one
 * loaded influence the second's timings.
 */
export function runBackendInWorker(
  backend: BackendId,
  reference: JvmReference,
  timeoutMs = 120_000,
): Promise<BackendReport> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
    })

    const settle = (report: BackendReport) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(report)
    }

    const failed = (error: string): BackendReport => ({
      backend,
      ok: false,
      error,
      loadMs: 0,
      cases: [],
      benchmarks: [],
    })

    const timer = setTimeout(
      () => settle(failed(`timed out after ${timeoutMs} ms`)),
      timeoutMs,
    )

    worker.onmessage = (event: MessageEvent<BackendReport>) => settle(event.data)
    worker.onerror = (event) =>
      settle(failed(event.message || 'worker failed to start (see console)'))

    worker.postMessage({
      backend,
      reference,
      baseUrl: document.baseURI,
    } satisfies SpikeRequest)
  })
}

export async function loadJvmReference(): Promise<JvmReference> {
  const response = await fetch(new URL('engine/jvm-reference.json', document.baseURI))
  if (!response.ok) {
    throw new Error(
      `could not load jvm-reference.json (${response.status}). Run: cd engine && ./gradlew jvmParity`,
    )
  }
  return response.json()
}

/** Best-effort environment notes worth recording alongside on-device results. */
export function environmentNotes(): Record<string, string> {
  const standalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches

  return {
    userAgent: navigator.userAgent,
    'home-screen (standalone)': standalone ? 'yes' : 'no — open from the Home Screen icon',
    'secure context': window.isSecureContext ? 'yes' : 'no — service worker unavailable',
    'hardware threads': String(navigator.hardwareConcurrency ?? 'unknown'),
  }
}
