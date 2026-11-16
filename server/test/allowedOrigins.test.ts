import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedOrigin, parseAllowedOrigins } from '../src/allowedOrigins'

test('only configured browser origins can connect', () => {
  const allowed = parseAllowedOrigins('https://conflux.example, http://localhost:5173')
  assert.equal(isAllowedOrigin('https://conflux.example', allowed), true)
  assert.equal(isAllowedOrigin('https://other.example', allowed), false)
  assert.equal(isAllowedOrigin(null, allowed), false)
  assert.equal(isAllowedOrigin('https://conflux.example/path', allowed), false)
})

test('invalid origin configuration is rejected', () => {
  assert.throws(() => parseAllowedOrigins(''))
  assert.throws(() => parseAllowedOrigins('https://conflux.example/app'))
  assert.throws(() => parseAllowedOrigins('javascript:alert(1)'))
})
