import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError } from './api.ts'
import { writeAllowed } from './accessPolicy.ts'

test('a revoked or expired session cannot write again', () => {
  assert.equal(writeAllowed({ scope: 'write', access: 'active' }), true)
  assert.equal(writeAllowed({ scope: 'read', access: 'revoked' }), false)
  assert.equal(writeAllowed({ scope: 'write', access: 'revoked' }), false)
  assert.equal(writeAllowed(null, new ApiError(401, 'invalid or expired token')), false)
  assert.equal(writeAllowed({ scope: 'write', access: 'active' }, new ApiError(403, 'document access policy does not allow this token to write')), false)
})
