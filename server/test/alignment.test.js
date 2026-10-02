import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, pairMaps, semanticPosition } from '../src/alignment.js'

const src = (nid, kind = 'paragraph', extra = {}) => ({ nid, kind, xrefs: [], ...extra })
const tgt = (nid, xrefs = [], extra = {}) => ({ nid, kind: 'paragraph', xrefs, ...extra })

test('一对多：中文单段 -> 英文两段，两条边 rel=1:n', () => {
  const g = buildGraph({
    srcBlocks: [src('s1')],
    tgtBlocks: [tgt('t1', ['s1']), tgt('t2', ['s1'])]
  })
  assert.equal(g.edges.length, 2)
  assert.ok(g.edges.every((e) => e.rel === '1:n'))
})

test('多对一：中文两段合并为英文一段，rel=n:1', () => {
  const g = buildGraph({
    srcBlocks: [src('s1'), src('s2')],
    tgtBlocks: [tgt('t1', ['s1', 's2'])]
  })
  assert.equal(g.edges.length, 2)
  assert.ok(g.edges.every((e) => e.rel === 'n:1'))
})

test('顺序完全打乱也按下标无关地正确配对', () => {
  const g = buildGraph({
    srcBlocks: [src('a'), src('b'), src('c')],
    tgtBlocks: [tgt('x', ['c']), tgt('y', ['a']), tgt('z', ['b'])]
  })
  const map = pairMaps(g.edges).src2tgt
  assert.deepEqual(map.get('a'), ['y'])
  assert.deepEqual(map.get('c'), ['x'])
})

test('来源缺失：xref 指向不存在的原文 -> 冲突边 + missingSource 诊断', () => {
  const g = buildGraph({ srcBlocks: [src('a')], tgtBlocks: [tgt('t', ['ghost'])] })
  assert.equal(g.diagnostics.missingSource[0].ref, 'ghost')
  const e = g.edges.find((x) => x.srcNid === 'ghost')
  assert.equal(e.conflict, 'missing-source')
  assert.equal(e.status, 'proposed')
})

test('共享代码按 codeRef 同名对齐，不依赖段落下标', () => {
  const g = buildGraph({
    srcBlocks: [src('p1'), src('code1', 'code', { codeRef: 'install' })],
    tgtBlocks: [tgt('code2', [], { kind: 'code', codeRef: 'install' }), tgt('p2', ['p1'])]
  })
  assert.ok(g.edges.some((e) => e.srcNid === 'code1' && e.tgtNid === 'code2' && e.origin === 'code'))
})

test('未匹配段落进入 unmatched（人工确认入口数据）', () => {
  const g = buildGraph({ srcBlocks: [src('a'), src('b')], tgtBlocks: [tgt('t', ['a'])] })
  assert.deepEqual(g.diagnostics.unmatchedSrc.map((x) => x.srcNid), ['b'])
})

test('被人工 reject 的边在重新声明前不参与配对，重新声明后回到 proposed', () => {
  const g1 = buildGraph({
    srcBlocks: [src('a')],
    tgtBlocks: [tgt('t', ['a'])],
    existing: [{ srcNid: 'a', tgtNid: 't', status: 'rejected' }]
  })
  assert.equal(g1.edges[0].status, 'proposed')
  // 没有重新声明（仅历史边）时不出现
  const g2 = buildGraph({
    srcBlocks: [src('a')],
    tgtBlocks: [tgt('t', [])],
    existing: [{ srcNid: 'a', tgtNid: 't', status: 'rejected' }]
  })
  assert.equal(g2.edges.length, 0)
})

test('semanticPosition：有对齐走对齐，无对齐兜底首个节点并标记 aligned=false', () => {
  const { src2tgt } = pairMaps(buildGraph({ srcBlocks: [src('a')], tgtBlocks: [tgt('t', ['a'])] }).edges)
  assert.deepEqual(semanticPosition('a', src2tgt, ['t']), { nid: 't', aligned: true })
  assert.deepEqual(semanticPosition('zzz', src2tgt, ['t']), { nid: 't', aligned: false })
})
