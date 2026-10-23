import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cssPixels, fitSlide, groupPages } from './fixedPages.ts'

test('a continued slide has one thumbnail and a different region starts a new page', () => {
  assert.deepEqual(groupPages([
    { sequence: 0, region: 'slide', continuation: false },
    { sequence: 1, region: 'slide', continuation: true },
    { sequence: 2, region: 'note', continuation: true },
    { sequence: 3, region: 'slide', continuation: false },
  ]), [
    { firstSequence: 0, region: 'slide', sequences: [0, 1] },
    { firstSequence: 2, region: 'note', sequences: [2] },
    { firstSequence: 3, region: 'slide', sequences: [3] },
  ])
})

test('fit considers both viewport dimensions, gutters, and portrait slides', () => {
  assert.equal(fitSlide({ width: 1280, height: 720 }, { width: 1008, height: 900 }), .75)
  assert.equal(fitSlide({ width: 1280, height: 720 }, { width: 2000, height: 408 }), .5)
  assert.equal(fitSlide({ width: 720, height: 1280 }, { width: 1000, height: 688 }), .5)
  assert.equal(fitSlide({ width: 1280, height: 720 }, { width: 0, height: 0 }), .05)
  assert.equal(fitSlide({ width: 1280, height: 720 }, { width: 10000, height: 10000 }), 2)
})

test('shape geometry preserves negative positions and converts points', () => {
  assert.equal(cssPixels('-18.5px'), -18.5)
  assert.equal(cssPixels('72pt'), 96)
  assert.equal(cssPixels('calc(100% - 20px)'), 0)
  assert.equal(cssPixels('NaNpx'), 0)
})
