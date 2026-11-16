// Run the CLI probe first, then inspect its generated previews in Chromium.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const output = dirname(fileURLToPath(import.meta.url))
const repo = resolve(output, '../../..')
const require = createRequire(resolve(repo, 'examples/hdoc/editor/package.json'))
const { chromium } = require('@playwright/test')
const result = JSON.parse(readFileSync(resolve(output, 'cli-results.json'), 'utf8'))
const browser = await chromium.launch({
  ...(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {}),
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const expected = [['700', 'normal'], ['400', 'italic'], ['400', 'normal'], ['400', 'italic'], ['400', 'normal']]
const metrics = {}
try {
  for (const format of ['docx', 'md']) {
    await page.goto(pathToFileURL(resolve(result.temporaryArtifacts, `preview-${format}.html`)).href)
    await page.evaluate(() => document.fonts.ready)
    metrics[format] = await page.locator('[data-hcd-node-hash]').evaluateAll(nodes => nodes.slice(0, 5).map(element => ({
      text: element.textContent,
      weight: getComputedStyle(element).fontWeight,
      style: getComputedStyle(element).fontStyle,
      size: getComputedStyle(element).fontSize,
    })))
    if (JSON.stringify(metrics[format].map(node => [node.weight, node.style])) !== JSON.stringify(expected)) {
      throw new Error(`${format}: unexpected inline styles ${JSON.stringify(metrics[format])}`)
    }
    const image = page.locator('img').first()
    await image.waitFor()
    if (!await image.evaluate(element => element.complete && element.naturalWidth > 0)) {
      throw new Error(`${format}: embedded raster did not load`)
    }
    const cell = page.locator('td').filter({ hasText: '280' }).first()
    if (await cell.locator('[data-hcd-node-hash]').evaluate(element => getComputedStyle(element).fontWeight) !== '700') {
      throw new Error(`${format}: table cell lost bold emphasis`)
    }
    await page.screenshot({ path: resolve(output, `source-free-${format}-readback.png`) })
  }
  const observedGaps = {}
  await page.goto(pathToFileURL(resolve(result.temporaryArtifacts, 'preview-xlsx.html')).href)
  observedGaps.xlsxRichCell = await page.locator('[data-hcd-node-hash]').filter({ hasText: '同名😀 tail plain' }).first()
    .evaluate(element => ({ text: element.textContent, weight: getComputedStyle(element).fontWeight, style: getComputedStyle(element).fontStyle }))
  writeFileSync(resolve(output, 'browser-metrics.json'), JSON.stringify({
    metrics, inlineWeightsAndStylesVerified: true, boldTableCellVerified: true,
    embeddedRasterLoaded: true, observedGaps, sameSourceOfficeVisualReference: false,
  }, null, 2) + '\n')
  console.log('DOCX / Markdown inline metrics, table emphasis and raster loading verified. XLSX rich-cell preview observation recorded.')
} finally {
  await browser.close()
}
