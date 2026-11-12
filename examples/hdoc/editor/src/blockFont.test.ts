import assert from 'node:assert/strict'
import { blockFontAttribute, jsonToSnapshot, parseBlockFont, projectionToJson, renderBlockFont, type Block, type Projection } from './schema.ts'
import { themeFontOptions, themeFontPatch } from './themeCss.ts'

const block = (over: Partial<Block>): Block => ({
  blockId: 'n_block',
  blockHash: 'hash',
  region: 'body',
  readOnly: false,
  content: { kind: 'paragraph', inlines: [{ text: 'Revenue in yen' }] },
  ...over,
})

const projection = (blocks: Block[]): Projection => ({ documentId: 'doc', revision: 3, blocks })

// A face read from the projection survives the model and comes back in the snapshot.
const pinned = block({ content: { kind: 'paragraph', font: { latin: 'Brand Serif', eastAsia: '等线' }, inlines: [{ text: 'Revenue in yen' }] } })
const snapshot = jsonToSnapshot(projectionToJson(projection([pinned])))
assert.deepEqual(snapshot[0].content.font, { latin: 'Brand Serif', eastAsia: '等线' })
assert.equal(JSON.parse(JSON.stringify(snapshot[0].content)).font.eastAsia, '等线')

// A block with no face sends no font key at all, so the server reads the block as it
// did before this field existed.
assert.equal('font' in jsonToSnapshot(projectionToJson(projection([block({})])))[0].content, false)

// Headings and list items carry it too: they are blocks as far as the server is.
const heading = block({ content: { kind: 'heading', level: 2, font: { latin: 'Brand Serif' }, inlines: [{ text: 'Quarter' }] } })
assert.deepEqual(jsonToSnapshot(projectionToJson(projection([heading])))[0].content.font, { latin: 'Brand Serif' })
const item = block({ content: { kind: 'list_item', level: 1, font: { bidi: 'Brand Naskh' }, inlines: [{ text: 'Item' }] } })
const itemList = jsonToSnapshot(projectionToJson(projection([item])))
assert.equal(itemList[0].content.kind, 'list_item')
assert.equal(itemList[0].content.level, 1)
assert.deepEqual(itemList[0].content.font, { bidi: 'Brand Naskh' })

// A read-only block (mixed run faces) keeps the content the server sent, font and all,
// so the checkpoint cannot claim it changed.
const readOnly = block({ readOnly: true, content: { kind: 'paragraph', inlines: [{ text: 'Left' }, { text: 'Right' }] } })
const opaque = jsonToSnapshot(projectionToJson(projection([readOnly])))[0]
assert.deepEqual(opaque.content, readOnly.content)

// The DOM form uses the same attribute names the server writes, so a copy keeps the
// face and a paste of server-rendered HTML reads it back.
const rendered = renderBlockFont({ latin: 'Brand Serif', eastAsia: '等线' })
assert.equal(rendered['data-hcd-font-latin'], 'Brand Serif')
assert.equal(rendered['data-hcd-font-east-asia'], '等线')
assert.equal(rendered.style, `font-family:'Brand Serif'`)
assert.equal(renderBlockFont(null) && Object.keys(renderBlockFont(null)).length, 0)
const element = { getAttribute: (name: string) => (({ 'data-hcd-font-latin': 'Brand Serif', 'data-hcd-font-bidi': 'Brand Naskh' } as Record<string, string>)[name] ?? null) } as unknown as HTMLElement
assert.deepEqual(parseBlockFont(element), { latin: 'Brand Serif', bidi: 'Brand Naskh' })
assert.equal(parseBlockFont({ getAttribute: () => null } as unknown as HTMLElement), null)
// Empty slots never reach the checkpoint: the server refuses a font object with none.
assert.deepEqual(blockFontAttribute({ hcdFont: { latin: null, eastAsia: '', bidi: 'Brand Naskh' } }), { font: { bidi: 'Brand Naskh' } })
assert.deepEqual(blockFontAttribute({ hcdFont: null }), {})

// The option the picker lists maps to exactly the slots the theme covers, which is the
// object the block model holds.
const options = themeFontOptions([
  { slot: 'major-latin', family: 'Brand Serif' },
  { slot: 'minor-latin', family: 'Brand Gothic' },
  { slot: 'minor-east-asia', family: 'Brand Gothic' },
])
assert.deepEqual(options.map(option => themeFontPatch(option)), [
  { latin: 'Brand Gothic', eastAsia: 'Brand Gothic' },
  { latin: 'Brand Serif' },
])
assert.deepEqual(jsonToSnapshot(projectionToJson(projection([block({ content: { kind: 'paragraph', font: themeFontPatch(options[0]), inlines: [{ text: 'x' }] } })])))[0].content.font,
  { latin: 'Brand Gothic', eastAsia: 'Brand Gothic' })
console.log('block font schema ok')
