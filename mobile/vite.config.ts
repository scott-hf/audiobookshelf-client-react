import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Prevent vite from walking up to the root Next.js app's postcss.config.mjs
  // (Tailwind v4 plugin object, incompatible with vite's default postcss loader).
  css: { postcss: { plugins: [] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
