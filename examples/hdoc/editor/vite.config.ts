import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 8767,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8766', ws: true },
      '/health': 'http://127.0.0.1:8766',
    },
  },
})
