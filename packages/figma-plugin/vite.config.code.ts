import { defineConfig } from 'vite'
import { buildId } from './build-id'

export default defineConfig({
  // I62 — stamp WHICH BUILD this bundle is, from the same source the server
  // bundle uses (scripts/build-id.sh). Read by
  // packages/shared/src/build-id.ts; an unstamped run falls back to 'source'.
  define: {
    FIGMA_BRIDGE_BUILD: JSON.stringify(buildId()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/code.ts',
      formats: ['iife'],
      name: 'code',
      fileName: () => 'code.js',
    },
    target: 'es2017',
    minify: false,
  },
})
