/**
 * The MapLibre worker, as a bundler entry point.
 *
 * MapLibre GL JS 6 ships its worker as a **separate ES module** (`maplibre-gl-worker.mjs`)
 * that imports a shared chunk, rather than inlining it as a blob the way v4/v5 did. It
 * locates that file at runtime with:
 *
 *     new URL('./maplibre-gl-worker.mjs', import.meta.url)
 *
 * — computed from a variable, so no bundler can see it statically. Once Vite bundles
 * maplibre into `assets/index-<hash>.js`, that resolves to `/assets/maplibre-gl-worker.mjs`,
 * which is never emitted. See `maplibreWorker.ts` for what that failure looks like.
 *
 * Importing the module here gives Vite something it *can* see: it bundles the worker
 * together with its shared chunk and emits a real asset. The module installs itself on
 * `self` on import, so there is nothing to call.
 *
 * The default export has to be *used*, not merely imported. maplibre's `sideEffects` field
 * covers only `*.css` and `src/**\/*.ts`, so a bare `import '…/maplibre-gl-worker.mjs'` is
 * treated as side-effect-free and tree-shaken away — which builds cleanly and emits a 0-byte
 * worker chunk. Assigning the binding keeps the module, and the assignment doubles as a
 * marker that can be probed from the worker.
 */
import MapLibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs'

;(self as unknown as { MapLibreWorker?: unknown }).MapLibreWorker = MapLibreWorker
