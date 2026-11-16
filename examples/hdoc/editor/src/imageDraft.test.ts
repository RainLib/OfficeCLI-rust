import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blankEdits } from './imageRender.ts'
import { parseImageInput, type ImageInput } from './imageDraft.ts'

const input = (): ImageInput => ({ schemaVersion: 'hcd-image-input/1', baseRevision: 2, width: 1080, height: 720,
  edits: blankEdits(1080, 720), strokes: [{ points: [[400, 500], [450.25, 530]], size: 48, erase: false }], cropSelection: null,
  prompt: '保留区域外像素', agentCount: 3, brush: 48, feather: 8, erase: false,
  conversion: { format: 'webp', width: 900, height: 600, quality: 63, transparent: true, original: false, fill: '#ffffff', filename: '候选' } })

test('image drafts retain exact mask coordinates, edits and conversion parameters', () => {
  const draft = input(); draft.edits.exposure = 17; draft.cropSelection = [20, 30, 200, 100]
  assert.deepEqual(parseImageInput(JSON.stringify(draft)), draft)
})

test('image recovery bounds mask replay and rejects invalid source, crop, point and conversion dimensions', () => {
  const invalid: unknown[] = [null, {}, { ...input(), baseRevision: -1 }, { ...input(), width: 9000 }, { ...input(), cropSelection: [1000, 30, 200, 100] },
    { ...input(), strokes: [{ points: [[1081, 20]], size: 48, erase: false }] },
    { ...input(), strokes: [{ points: Array(100001).fill([1, 1]), size: 48, erase: false }] },
    { ...input(), conversion: { ...input().conversion, width: 0 } }]
  for (const draft of invalid) assert.throws(() => parseImageInput(JSON.stringify(draft)))
})
