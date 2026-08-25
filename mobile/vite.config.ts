import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { sharedAliases } from './aliases'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: sharedAliases },
  // Prevent vite from walking up to the root Next.js app's postcss.config.mjs
  // (Tailwind v4 plugin object, incompatible with vite's default postcss loader).
  // Tailwind itself runs through @tailwindcss/vite above, not postcss.
  css: { postcss: { plugins: [] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
