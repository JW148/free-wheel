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
        name: 'free-wheel',
        short_name: 'free-wheel',
        description: 'Offline cycle route planner — routing and maps entirely on the phone',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        // Matches the ride screen's deepest slate, so the status bar area does not flash a
        // different colour on launch.
        background_color: '#06141b',
        theme_color: '#06141b',
        orientation: 'portrait',
        categories: ['navigation', 'sports', 'travel'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // A separate maskable entry: Android crops `any` icons to an arbitrary shape and
          // would take a bite out of a wheel.
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The engine artifacts live in public/ and must be available offline.
        // The 4 MB per-file default is fine here; .rd5 tiles go to OPFS, never Workbox.
        //
        // `pbf` and `png` are the glyph ranges and sprite sheet. PMTiles archives contain
        // neither, and MapLibre fetches them over the network on its own — miss them here and
        // the map goes offline with no labels and no icons, which looks like a styling bug.
        //
        // `brf` and `dat` are the routing profiles. These normally reach the phone via
        // `provisionOpfs` on first init, which fetches them — fine, because the first launch
        // is online. The failure mode they close is the second one: WebKit evicts OPFS under
        // storage pressure, and without a precached copy the profiles cannot be restored
        // offline, so routing dies mid-ride with no way back. 144 kB is cheap for that.
        globPatterns: ['**/*.{js,css,html,svg,json,wasm,pbf,png,brf,dat}'],
        // Without these, a new build sits in "waiting" until every tab of the app is
        // closed — and an iOS home-screen app is almost never truly closed, so a pull to
        // refresh keeps serving the previous bundle. This cost real debugging time three
        // times over; take the update immediately instead.
        skipWaiting: true,
        clientsClaim: true,
        // The tile catalogue is regenerated independently of the app bundle, so it must
        // not be frozen into a precache entry keyed by the build.
        navigateFallbackDenylist: [/^\/segments4\//, /^\/ca\.crt$/],
        // A 76 km route's Wasm engine plus glyphs runs past the 2 MiB default, and a
        // partially precached app is an app that fails in airplane mode.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
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
