import { cpSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** Vendor font assets are served by the host; a private workspace never needs
 * a public CDN merely to draw or export a canvas. */
export function canvasAssets(): Plugin {
  const root = dirname(fileURLToPath(import.meta.url))
  const fonts = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
  return {
    name: 'officecli-canvas-assets',
    configureServer(server) {
      server.middlewares.use('/canvas-assets/fonts/', (request, response, next) => {
        const relative = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname).slice(1)
        const file = resolve(fonts, relative)
        if (!file.startsWith(fonts + sep) || !existsSync(file)) { next(); return }
        response.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream')
        response.end(readFileSync(file))
      })
    },
    writeBundle(options) { if (options.dir) cpSync(fonts, join(options.dir, 'canvas-assets/fonts'), { recursive: true }) },
  }
}
