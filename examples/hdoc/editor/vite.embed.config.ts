import { defineConfig } from 'vite'
import { canvasAssets } from './canvasAssets.ts'

export default defineConfig({
  base: './',
  plugins: [canvasAssets()],
  build: {
    outDir: 'dist-embed',
    lib: { entry: 'src/embed.tsx', formats: ['es'], fileName: 'hcd-editor' },
    rollupOptions: { external: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/] },
  },
})
