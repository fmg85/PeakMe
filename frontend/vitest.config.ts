import { defineConfig } from 'vitest/config'

// Standalone test config (does NOT load vite.config.ts, so the PWA plugin etc.
// don't run during tests). The offline suite is pure logic + IndexedDB, so the
// node environment + fake-indexeddb is enough — no jsdom/browser needed.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
