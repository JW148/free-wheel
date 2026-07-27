/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Build timestamp, injected by vite.config.ts. Shown in the UI to identify the bundle. */
declare const __BUILD_ID__: string

/**
 * MapLibre 6's worker chunk. Shipped as a real file but absent from the package's `exports`
 * types, so it needs declaring to be imported by path — which `src/map/maplibreWorkerEntry.ts`
 * must do, since MapLibre's own runtime lookup of it cannot survive bundling.
 */
declare module 'maplibre-gl/dist/maplibre-gl-worker.mjs' {
  const MapLibreWorker: unknown
  export default MapLibreWorker
}
