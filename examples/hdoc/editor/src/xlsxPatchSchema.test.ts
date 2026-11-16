import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'

test('published XLSX content schema accepts standalone rich edits and mixed native types', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../../crates/hcd-core/schemas/hcd-patch-50.schema.json', import.meta.url), 'utf8'))
  const validate = new Ajv2020({ allErrors: true }).compile(schema)
  const sheetId = `s_${'a'.repeat(32)}`, nodeId = `n_${'b'.repeat(32)}`
  const runs = [{ text: '新😀', properties: { b: { val: '1' }, color: { rgb: 'FF228844' } } }]
  const precondition = { nodeHash: 'c'.repeat(64) }
  const create = { op: 'xlsx.richText.create', sheetId, row: 2, column: 2, runs }
  const set = { op: 'xlsx.richText.set', nodeId, runs, precondition }
  const number = { op: 'xlsx.number.set', sheetId, nodeId, value: '7', precondition }
  const formula = { op: 'xlsx.formula.create', sheetId, row: 2, column: 3, formula: '=B1*2' }
  const batch = (operations: unknown[]) => ({ schemaVersion: 'hcd-patch/50', documentId: 'schema-probe', patchId: 'test', baseRevision: 0, operations })
  for (const operations of [[create], [set], [formula], [create, number, formula]]) {
    assert.equal(validate(batch(operations)), true, JSON.stringify(validate.errors))
  }
  for (const operations of [[], [{ ...create, row: 0 }], [{ ...create, runs: [] }],
    [{ ...set, precondition: {} }], [{ ...create, runs: [{ text: 'bad', properties: { script: {} } }] }]]) {
    assert.equal(validate(batch(operations)), false, JSON.stringify(operations))
  }
})
