import assert from 'node:assert/strict'
import { applyThemeFaces, editorThemeRules } from './themeCss.ts'

const href = '/v1/documents/demo/theme/files/abcd'
const css = `@font-face{src:url("${href}");}\n:root{--hcd-major-latin:'Source Han Sans',sans-serif;}`
const applied = applyThemeFaces(css, [{ href, dataUrl: 'data:font/woff2;base64,QQ==' }])
assert.equal(applied.includes('data:font/woff2;base64,QQ=='), true)
assert.equal(applied.includes(href), false)
const blocked = applyThemeFaces(`${css}url("https://evil.test/font")`, [{ href: 'https://evil.test/font', dataUrl: 'data:font/woff2;base64,QQ==' }])
assert.equal(blocked.includes('https://evil.test/font'), true)
assert.equal(blocked.includes('data:font/woff2'), false)
assert.equal(editorThemeRules().includes('--hcd-minor-latin'), true)
console.log('theme css rewrite ok')
