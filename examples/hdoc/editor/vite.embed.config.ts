import { defineConfig } from 'vite'
import { canvasAssets } from './canvasAssets.ts'
import { pdfOcrAssets } from './pdfOcrAssets.mjs'

export default defineConfig({
  base: './',
  plugins: [canvasAssets(), pdfOcrAssets(true)],
  build: {
    outDir: 'dist-embed',
    lib: { entry: 'src/embed.tsx', formats: ['es'], fileName: 'hcd-editor' },
    rollupOptions: { external: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/] },
  },
})
