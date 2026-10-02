import { test } from 'node:test'
import assert from 'node:assert/strict'
import { protectedTokens, missingProtected, normalize, hash } from '../src/util.js'

test('行内代码与 keep 标记都作为受保护片段', () => {
  assert.deepEqual(protectedTokens('调用 `createApp` 并保留 [[keep:MyComponentLib]]'), [
    'createApp',
    'MyComponentLib'
  ])
})

test('译文丢失参数名被检出（参数名引用必须一致）', () => {
  // 纯文本出现不算“引用一致”，必须保留行内代码标记
  const miss = missingProtected('使用 `options` 与 `createApp`', 'use createApp only')
  assert.deepEqual(miss, ['options', 'createApp'])
  const ok = missingProtected('使用 `options` 与 `createApp`', 'use `options` with `createApp`')
  assert.deepEqual(ok, [])
})

test('规范化后哈希稳定', () => {
  assert.equal(hash('a\r\nb  \n'), hash('a\nb'))
  assert.notEqual(hash('a'), hash('b'))
  assert.equal(normalize('X\r\n'), 'X')
})
