import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Stamped into the UI so a device can be told, at a glance, which bundle it is running.
// Guessing at that is what made the stale-service-worker problem so slow to spot.
const BUILD_ID = new Date().toISOString().replace('T', ' ').slice(0, 19)

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // iOS 26 dropped every installability requirement, so a manifest is no longer
      // strictly required to Add to Home Screen — but it is what gives the standalone
      // display mode that the spike reports on.
      manifest: {
        name: 'free-wheel — Spike 1',
        short_name: 'free-wheel',
        description: 'Offline cycle route planner: TeaVM toolchain proof',
        display: 'standalone',
        background_color: '#17181d',
        theme_color: '#17181d',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // The engine artifacts live in public/ and must be available offline.
        // The 4 MB per-file default is fine here; .rd5 tiles go to OPFS, never Workbox.
        //
        // `pbf` and `png` are the glyph ranges and sprite sheet. PMTiles archives contain
        // neither, and MapLibre fetches them over the network on its own — miss them here and
        // the map goes offline with no labels and no icons, which looks like a styling bug.
        globPatterns: ['**/*.{js,css,html,svg,json,wasm,pbf,png}'],
        // Without these, a new build sits in "waiting" until every tab of the app is
        // closed — and an iOS home-screen app is almost never truly closed, so a pull to
        // refresh keeps serving the previous bundle. This cost real debugging time three
        // times over; take the update immediately instead.
        skipWaiting: true,
        clientsClaim: true,
        // The tile catalogue is regenerated independently of the app bundle, so it must
        // not be frozen into a precache entry keyed by the build.
        navigateFallbackDenylist: [/^\/segments4\//, /^\/ca\.crt$/],
      },
      devOptions: {
        // Exercise the service worker in `npm run dev` rather than only after a
        // production build.
        enabled: true,
        type: 'module',
      },
    }),
  ],
  worker: {
    // MapLibre constructs its worker with `{ type: 'module' }` and only falls back to a
    // classic worker if that throws synchronously. Vite's default worker format is `iife`,
    // which loads as a module too, but keeping both sides ESM means dev and build agree —
    // and this pipeline has already lost enough time to a worker that failed quietly.
    format: 'es',
  },
  server: {
    // Reachable from a phone on the same network; pair with a tunnel for HTTPS.
    host: true,
  },
  preview: {
    host: true,
  },
})
