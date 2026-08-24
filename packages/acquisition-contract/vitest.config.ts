import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Prevent vite from walking up to the root Next.js app's postcss.config.mjs
  // (Tailwind v4 plugin object, incompatible with vite's default postcss loader)
  // -- this package has no CSS to process.
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node'
  }
})
