import { defineConfig } from 'vitest/config'

// Separate from `vite.config.ts` deliberately: that config carries the PWA plugin and the
// worker settings, none of which a unit test needs, and the service worker generation is
// slow enough to make the test loop annoying.
export default defineConfig({
  test: {
    // No DOM. The pure modules need none, and the ones that touch storage run against
    // `src/engine/fakeOpfs.ts` rather than a browser. Anything needing a real Map, real
    // OPFS or a network is verified on-device instead, per the project's rule that desktop
    // proves nothing about the device.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.mjs'],
  },
})
