import assert from 'node:assert/strict'
import { applyThemeFaces, editorThemeRules, hasThemeRegion, loadTheme, loadThemeCss, themeFontOptions, themeFontPatch } from './themeCss.ts'

const href = '/v1/documents/demo/theme/files/abcd'
const css = `@font-face{src:url("${href}");}\n:root{--hcd-major-latin:'Source Han Sans',sans-serif;}`
const applied = applyThemeFaces(css, [{ href, dataUrl: 'data:font/woff2;base64,QQ==' }])
assert.equal(applied.includes('data:font/woff2;base64,QQ=='), true)
assert.equal(applied.includes(href), false)
const blocked = applyThemeFaces(`${css}url("https://evil.test/font")`, [{ href: 'https://evil.test/font', dataUrl: 'data:font/woff2;base64,QQ==' }])
assert.equal(blocked.includes('https://evil.test/font'), true)
assert.equal(blocked.includes('data:font/woff2'), false)
assert.equal(editorThemeRules().includes('--hcd-minor-latin'), true)
assert.equal(hasThemeRegion('article{color:#222}\n/* hcd-theme-begin */\n:root{--hcd-major-latin:\'A\'}\n/* hcd-theme-end */'), true)
assert.equal(hasThemeRegion('article{color:#222}\n:root{--hcd-major-latin:\'A\';}'), false)

// A surface that renders the document stylesheet asks for font bytes alone, and
// gets back only the @font-face rules with the bytes inlined.
const requested: string[] = []
const themeCssBody = `${css}\n:root{--hcd-major-latin:'Source Han Sans',sans-serif;}`
const fetches: string[] = []
;(globalThis as Record<string, unknown>).fetch = async (input: string | URL, init?: { headers?: Record<string, string> }) => {
  const url = String(input)
  fetches.push(url)
  requested.push(String(init?.headers?.Authorization ?? ''))
  if (url.includes('/theme/files/')) return { ok: true, blob: async () => new Blob(['font bytes'], { type: 'font/ttf' }) }
  if (url.includes('/theme')) {
    // What the server does for faces=only: keep the @font-face lines, drop the rest.
    const served = url.includes('faces=only')
      ? themeCssBody.split('\n').filter(line => line.startsWith('@font-face{')).join('\n')
      : themeCssBody
    return { status: 200, ok: true, json: async () => ({ theme: { css: served, faces: [
      { href, webPreview: true, slot: 'major-latin', family: 'Brand Serif' },
      { href: '/v1/documents/demo/theme/files/efgh', webPreview: true, slot: 'minor-east-asia', family: 'Brand Gothic' },
      // The same family in another slot merges into one option, not a second row.
      { slot: 'minor-latin', family: 'Brand Gothic' },
      { slot: 'major-bidi', family: 'Brand Naskh' },
      // Names a text.font patch would refuse, or that fills no known slot, are not offered.
      { slot: 'major-latin', family: 'Evil;' },
      { slot: 'major-latin', family: '<b>Tag</b>' },
      { slot: 'major-latin', family: 'Tab\tFace' },
      { slot: 'huge-latin', family: 'Unknown Slot' },
      { slot: '', family: 'No Slot' },
      { family: '  ' },
      { slot: 'major-latin', family: 'x'.repeat(129) },
    ] } }) }
  }
  return { ok: true, blob: async () => new Blob(['font bytes'], { type: 'font/ttf' }) }
}
;(globalThis as Record<string, unknown>).FileReader = class {
  result = `data:font/ttf;base64,${Buffer.from('font bytes').toString('base64')}`
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL() { queueMicrotask(() => this.onload?.()) }
}
const session = { apiUrl: '/v1/documents', documentId: 'demo', token: 'doc-token' } as unknown as Parameters<typeof loadThemeCss>[0]
const onlyFaces = await loadThemeCss(session, 3, { facesOnly: true })
assert.equal(fetches[0], '/v1/documents/demo/theme?revision=3&faces=only')
assert.equal(onlyFaces.includes('data:font/ttf;base64,'), true)
assert.equal(onlyFaces.includes('--hcd-major-latin'), false)
assert.equal(onlyFaces.includes('@font-face'), true)

// Without the option the whole block still comes back, and a revision-less
// request carries no query string at all.
fetches.length = 0
const fullBlock = await loadThemeCss(session, null)
assert.equal(fetches[0], '/v1/documents/demo/theme')
assert.equal(fullBlock.includes('--hcd-major-latin'), true)
assert.equal(requested.every(header => header === 'Bearer doc-token'), true)
// The fixed viewer lists the families the pinned theme covers and patches
// exactly those slots, so an option never offers a slot the theme has no face for.
const theme = await loadTheme(session, null)
assert.deepEqual(themeFontOptions(theme.faces), [
  { family: 'Brand Gothic', latin: true, eastAsia: true, bidi: false },
  { family: 'Brand Naskh', latin: false, eastAsia: false, bidi: true },
  { family: 'Brand Serif', latin: true, eastAsia: false, bidi: false },
])
assert.deepEqual(themeFontPatch({ family: 'Brand Gothic', latin: true, eastAsia: true, bidi: false }),
  { latin: 'Brand Gothic', eastAsia: 'Brand Gothic' })
assert.deepEqual(themeFontPatch({ family: 'Brand Naskh', latin: false, eastAsia: false, bidi: true }),
  { bidi: 'Brand Naskh' })
// A CJK family is a legal patch value: only the characters that break an HTML
// attribute or a CSS declaration are refused.
assert.deepEqual(themeFontOptions([{ slot: 'minor-east-asia', family: '等线' }]),
  [{ family: '等线', latin: false, eastAsia: true, bidi: false }])
// A document with no pin has no css and no faces, so the viewer has nothing to offer.
const unpinned = { apiUrl: '/v1/documents', documentId: 'fresh', token: 'doc-token' } as unknown as Parameters<typeof loadTheme>[0]
;(globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
  if (String(input).includes('/fresh/theme')) return { status: 404, ok: false, text: async () => 'not found' }
  throw new Error(`unexpected request ${String(input)}`)
}
const noTheme = await loadTheme(unpinned, null)
assert.deepEqual(noTheme, { css: '', faces: [] })
assert.deepEqual(themeFontOptions(noTheme.faces), [])
console.log('theme css rewrite ok')
