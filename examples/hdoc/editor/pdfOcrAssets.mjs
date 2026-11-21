import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Ship the browser OCR engine and its trained data with every editor build. */
export function pdfOcrAssets(library = false) {
  const project = dirname(fileURLToPath(import.meta.url))
  const modules = join(project, 'node_modules')
  const files = new Map([
    ['worker.min.js', join(modules, 'tesseract.js/dist/worker.min.js')],
    ['tesseract.js-LICENSE.txt', join(modules, 'tesseract.js/LICENSE.md')],
    ['tesseract-core-LICENSE.txt', join(modules, 'tesseract.js-core/LICENSE')],
    ['tessdata-LICENSE.txt', join(project, '../../../crates/pdf-handler/assets/GlyphLessFont-LICENSE.txt')],
    ['tessdata-NOTICE.txt', join(project, 'pdfOcrTrainedDataNotice.txt')],
    ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].map(kind => {
      const name = `tesseract-core-${kind}.wasm.js`
      return [name, join(modules, 'tesseract.js-core', name)]
    }),
    ...['eng', 'chi_sim', 'chi_tra'].map(language => {
      const name = `${language}.traineddata.gz`
      return [name, join(modules, '@tesseract.js-data', language, '4.0.0_best_int', name)]
    }),
  ])
  return {
    name: 'officecli-pdf-ocr-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url || '/', 'http://localhost').pathname
        const name = path.match(/\/pdf-ocr-assets\/([^/]+)$/)?.[1]
        const file = name && files.get(name)
        if (!file) { next(); return }
        const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : name.endsWith('.gz') ? 'application/gzip' : 'text/plain; charset=utf-8'
        response.setHeader('Content-Type', type)
        response.end(readFileSync(file))
      })
    },
    writeBundle(options) {
      if (!options.dir) return
      const directory = join(options.dir, library ? 'pdf-ocr-assets' : 'assets/pdf-ocr-assets')
      mkdirSync(directory, { recursive: true })
      for (const [name, file] of files) copyFileSync(file, join(directory, name))
    },
  }
}
