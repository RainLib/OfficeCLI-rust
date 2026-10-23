import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist-embed',
    lib: { entry: 'src/embed.tsx', formats: ['es'], fileName: 'hcd-editor' },
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
  },
})
