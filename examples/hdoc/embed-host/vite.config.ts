import { defineConfig } from 'vite'
import { pdfOcrAssets } from '../editor/pdfOcrAssets.mjs'

export default defineConfig({
  base: '/embed-example/',
  plugins: [pdfOcrAssets()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { chunkSizeWarningLimit: 16000 },
  server: {
    port: 8771,
    proxy: { '/v1': 'http://127.0.0.1:8766', '/canvas-assets': 'http://127.0.0.1:7400' },
  },
})
