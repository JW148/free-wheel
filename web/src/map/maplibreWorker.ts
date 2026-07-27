import { setWorkerUrl } from 'maplibre-gl'
// `?worker&url` makes Vite bundle maplibreWorkerEntry.ts as its own worker chunk and hand
// back the emitted URL, instead of inlining it into the main bundle.
import workerUrl from './maplibreWorkerEntry?worker&url'

/**
 * Points MapLibre at the worker chunk Vite actually emitted.
 *
 * ## Why this is needed at all
 *
 * MapLibre 6 derives its worker URL from `import.meta.url` at runtime. Bundled, that is the
 * app chunk, so it asks for `/assets/maplibre-gl-worker.mjs` — a file that does not exist.
 *
 * **This is what stopped the map rendering for the whole of Phase 3, and it is worth knowing
 * exactly how it hides.** A dev server's SPA fallback answers the missing path with
 * `index.html` and a `200`, so there is no 404 to notice. The browser then tries to parse
 * HTML as a module worker and the worker dies. MapLibre only wraps the `new Worker(...)`
 * call in try/catch, which catches a *synchronous* throw — a script that fails to parse
 * fails asynchronously, so nothing is caught and nothing is logged.
 *
 * The map then behaves like this: the style loads, the background layer paints, `sourcedata`
 * never fires, no tiles are requested, `load` never fires, and no `error` event is emitted.
 * That looks like a broken tile source. It is not — every source type routes through the
 * worker pool, which is why an OPFS-backed archive, an HTTP-backed archive and a plain
 * inline GeoJSON source all failed identically.
 *
 * ## Call it before constructing any Map
 *
 * The worker pool is created lazily on first use and the URL is read then, so this must run
 * first — same constraint as `addProtocol`, and for the same reason. Both are called at
 * module scope in `MapPanel.tsx`.
 */
export function configureMapLibreWorker(): string {
  setWorkerUrl(workerUrl)
  return workerUrl
}

/**
 * Confirms the worker URL serves JavaScript rather than an SPA fallback page.
 *
 * Cheap insurance against the failure above recurring — a MapLibre upgrade that renames the
 * worker chunk, or a bundler change that stops emitting it, would otherwise land as another
 * silent no-render. Checking the content type is the point: the status code is `200` in the
 * broken case, which is precisely why it went unnoticed for so long.
 *
 * @returns `null` when the worker looks fine, or a description of what came back instead
 */
export async function checkMapLibreWorker(): Promise<string | null> {
  try {
    const response = await fetch(workerUrl, { method: 'GET', cache: 'no-store' })
    if (!response.ok) return `${workerUrl} → HTTP ${response.status}`
    const type = response.headers.get('content-type') ?? 'none'
    if (!/javascript|ecmascript/i.test(type)) {
      return `${workerUrl} served as "${type}", not JavaScript — the worker cannot start`
    }
    return null
  } catch (error) {
    return `${workerUrl}: ${error instanceof Error ? error.message : String(error)}`
  }
}
