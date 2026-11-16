import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const output = dirname(fileURLToPath(import.meta.url))
const repo = resolve(output, '../../..')
const require = createRequire(resolve(repo, 'examples/hdoc/editor/package.json'))
const { chromium } = require('@playwright/test')
const result = JSON.parse(readFileSync(resolve(output, 'cli-results.json'), 'utf8'))
const expected = [['700', 'normal'], ['400', 'italic'], ['400', 'normal'], ['400', 'italic'], ['400', 'normal']]
const browser = await chromium.launch({
  ...(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {}),
  headless: true,
})
const metrics = {}
const images = {}
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  for (const format of ['html', 'docx', 'md']) {
    await page.goto(pathToFileURL(resolve(result.temporaryArtifacts, `preview-${format}.html`)).href)
    await page.evaluate(() => document.fonts.ready)
    metrics[format] = await page.locator('[data-hcd-node-hash]').evaluateAll(nodes => {
      const start = nodes.findIndex(element => element.textContent?.startsWith('同名😀'))
      return nodes.slice(start, start + 5).map(element => ({
        text: element.textContent, weight: getComputedStyle(element).fontWeight,
        style: getComputedStyle(element).fontStyle,
      }))
    })
    if (JSON.stringify(metrics[format].map(node => [node.weight, node.style])) !== JSON.stringify(expected)) {
      throw new Error(`${format}: unexpected inline styles ${JSON.stringify(metrics[format])}`)
    }
    const image = page.locator('img').first()
    if (!await image.evaluate(element => element.complete && element.naturalWidth > 0)) throw new Error(`${format}: raster missing`)
    images[format] = await image.evaluate(element => ({
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
      codeWrapper: !!element.closest('pre,code'),
    }))
    if (Math.abs(images[format].width - 64) > 0.5 || Math.abs(images[format].height - 64) > 0.5 || images[format].codeWrapper) throw new Error(`${format}: image dimensions or wrapper changed ${JSON.stringify(images[format])}`)
    const cell = page.locator('td').filter({ hasText: '280' }).first()
    if (await cell.locator('[data-hcd-node-hash]').evaluate(element => getComputedStyle(element).fontWeight) !== '700') throw new Error(`${format}: table emphasis lost`)
    await page.screenshot({ path: resolve(output, `${format}-readback.png`) })
  }
  writeFileSync(resolve(output, 'browser-metrics.json'), JSON.stringify({
    metrics, images, inlineWeightsAndStylesVerified: true, boldTableCellVerified: true,
    rasterLoaded: true, sameSourceOfficeVisualReference: false,
  }, null, 2) + '\n')
  console.log('HTML / DOCX / Markdown rendered inline styles, table emphasis and raster verified.')
} finally {
  await browser.close()
}
