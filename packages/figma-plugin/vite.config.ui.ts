import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/ui.html'),
    },
  },
})
