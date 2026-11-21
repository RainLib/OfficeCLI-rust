import assert from 'node:assert/strict'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { createWordReviewAnchors, wordReviewAnchors } from '../src/wordReviewAnchors'

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' },
  paragraph: { content: 'text*', attrs: { hcdBlockId: { default: null } } },
  text: {},
}, marks: { bold: {} } })
const paragraph = (id: string, text: string) => schema.node('paragraph', { hcdBlockId: id }, schema.text(text))
const original = schema.node('doc', null, [paragraph('first', '甲😀乙'), paragraph('second', 'Next meeting')])
let state = EditorState.create({ doc: original, plugins: [createWordReviewAnchors()] })
state = state.apply(state.tr.setMeta(wordReviewAnchors, { anchors: [
  { id: 'emoji', location: { blockId: 'first', start: 1, end: 2 } },
  { id: 'meeting', location: { blockId: 'second', start: 0, end: 4 } },
] }))
function quote(id: string) {
  const anchor = wordReviewAnchors.getState(state)!.anchors.find(anchor => anchor.id === id)!
  return anchor.from !== undefined && anchor.to !== undefined ? state.doc.textBetween(anchor.from, anchor.to) : null
}
function replaceFromYjs(doc: Node) {
  state = state.apply(state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta(ySyncPluginKey, { isChangeOrigin: true }))
}
assert.equal(quote('emoji'), '😀', 'native scalar offsets resolve to a full UTF-16 emoji')
state = state.apply(state.tr.insertText('会议：', 1))
assert.equal(quote('emoji'), '😀', 'a local prefix follows normal PM steps')
replaceFromYjs(original)
assert.equal(quote('emoji'), '😀', 'Yjs undo preserves the range through a document replacement')
assert.equal(quote('meeting'), 'Next', 'undo preserves another paragraph anchor')
replaceFromYjs(schema.node('doc', null, [original.child(1), original.child(0)]))
assert.equal(quote('emoji'), '😀', 'stable paragraph IDs follow peer reordering')
assert.equal(quote('meeting'), 'Next')
replaceFromYjs(schema.node('doc', null, [schema.node('paragraph', { hcdBlockId: 'second' }, schema.text('Next meeting', [schema.mark('bold')])), original.child(0)]))
assert.equal(quote('meeting'), 'Next', 'a peer formatting change does not collapse the range')
replaceFromYjs(schema.node('doc', null, [original.child(1)]))
assert.equal(quote('emoji'), null, 'deleting the anchor paragraph never highlights unrelated text')
replaceFromYjs(original)
assert.equal(quote('emoji'), '😀', 'restoring the paragraph recovers its anchor')
assert.equal(quote('meeting'), 'Next')
console.log('Word comment anchors: local edit, Yjs undo, peer reordering/formatting, delete/restore, and Unicode passed.')
