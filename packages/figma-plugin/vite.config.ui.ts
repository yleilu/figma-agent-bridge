import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { buildId } from './build-id'

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  root: 'src',
  // I62 — the UI bundle sends the register frame, so it is the half that
  // publishes the build id to the channel registry. Stamped from the same
  // source as the code bundle and the server bundle (scripts/build-id.sh).
  define: {
    FIGMA_BRIDGE_BUILD: JSON.stringify(buildId()),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/ui.html'),
    },
  },
})
