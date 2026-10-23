import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextDraftStore, type TextRun } from './textDrafts.ts'

const base: TextRun = { nodeId: 'node', nodeHash: 'initial', text: 'original' }

test('drafts survive viewport reloads, unrelated revisions and remote conflicts', () => {
  const store = new TextDraftStore()
  store.edit(base, 1, 'my unsaved text')
  store.reconcile([], 2)
  store.reconcile([base], 2)
  assert.equal(store.get('node')?.text, 'my unsaved text')
  const remote = { ...base, nodeHash: 'remote', text: 'remote text' }
  store.reconcile([remote], 3)
  assert.equal(store.get('node')?.text, 'my unsaved text')
  assert.equal(store.get('node')?.remote?.text, 'remote text')
  store.resolve(remote, 3, true)
  assert.equal(store.get('node')?.base.nodeHash, 'remote')
  assert.equal(store.get('node')?.remote, undefined)
  store.resolve(remote, 3, false)
  assert.equal(store.size, 0)
})

test('late save responses preserve text typed during the request', () => {
  const store = new TextDraftStore()
  store.edit(base, 1, 'first edit')
  const sent = store.entries()
  store.edit(base, 1, 'newer edit')
  store.acknowledge(sent, 2, { node: 'saved' })
  assert.equal(store.get('node')?.text, 'newer edit')
  assert.equal(store.get('node')?.base.text, 'first edit')
  store.reconcile([{ ...base, nodeHash: 'saved', text: 'first edit' }], 2)
  assert.equal(store.get('node')?.remote, undefined)
})

test('a save acknowledgement cannot discard a newer remote conflict', () => {
  const store = new TextDraftStore()
  store.edit(base, 1, 'local')
  const sent = store.entries()
  store.reconcile([{ ...base, nodeHash: 'remote', text: 'remote' }], 3)
  store.acknowledge(sent, 2, { node: 'saved' })
  assert.equal(store.get('node')?.text, 'local')
  assert.equal(store.get('node')?.remote?.nodeHash, 'remote')
})

test('reverting to the original text during a save remains a pending edit', () => {
  const store = new TextDraftStore()
  store.edit(base, 1, 'sent edit')
  const sent = store.entries()
  store.beginSave(sent)
  store.edit(base, 1, base.text)
  store.reconcile([base], 1)
  assert.equal(store.get('node')?.text, base.text)
  store.acknowledge(sent, 2, { node: 'saved' })
  store.endSave(sent)
  assert.equal(store.get('node')?.text, 'original')
  assert.equal(store.get('node')?.base.text, 'sent edit')
})

test('typing after acknowledgement uses the saved base while the preview still reloads', () => {
  const store = new TextDraftStore()
  store.edit(base, 1, 'saved edit')
  store.acknowledge(store.entries(), 2, { node: 'saved' })
  assert.equal(store.currentRun(base, 1).text, 'saved edit')
  store.edit(base, 1, base.text)
  assert.equal(store.get('node')?.base.nodeHash, 'saved')
  assert.equal(store.get('node')?.text, 'original')
  assert.equal(store.currentRun({ ...base, nodeHash: 'new-remote' }, 3).nodeHash, 'new-remote')
})

test('a same-revision reconnect detects deleted or unloaded remote content without discarding local text', () => {
  const store = new TextDraftStore()
  store.edit(base, 3, 'my draft')
  store.reconcileHashes({ node: 'remote-hash' }, 3)
  assert.equal(store.get('node')?.stale, 'refresh')
  assert.equal(store.get('node')?.text, 'my draft')
  store.reconcile([{ ...base, nodeHash: 'remote-hash', text: 'remote content' }], 3)
  assert.equal(store.get('node')?.stale, undefined)
  assert.equal(store.get('node')?.remote?.text, 'remote content')
  store.reconcileHashes({ node: null }, 4)
  assert.equal(store.get('node')?.stale, 'deleted')
  store.acknowledge(store.entries(), 3, { node: 'saved' })
  assert.equal(store.get('node')?.text, 'my draft')
  assert.equal(store.get('node')?.stale, 'deleted')
  store.discard('node')
  assert.equal(store.size, 0)
})
