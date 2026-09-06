import { defineConfig } from 'vitest/config'

// Separate from `vite.config.ts` deliberately: that config carries the PWA plugin and the
// worker settings, none of which a unit test needs, and the service worker generation is
// slow enough to make the test loop annoying.
export default defineConfig({
  test: {
    // The only unit-tested code is pure (GPX parsing), so no DOM is needed. Anything
    // needing a Map or OPFS is verified on-device instead, per the project's rule that
    // desktop proves nothing about the device.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
