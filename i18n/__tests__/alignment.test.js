import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, foldGraph, semanticNode, describeLockVsGraph } from '../core/graph.js'
import { createStore } from '../store/createStore.js'
import { seed, buttonDoc } from '../fixtures/seed.js'
import { createContentApi } from '../core/content.js'

const fresh = () => createContentApi(createStore(seed))

test('1:N mapping is explicit and grouped, never positional', () => {
  const api = fresh()
  const c = api.getContent('components/button', { lang: 'en', sourceVersion: '1.0.0' })
  const node = semanticNode(c.graph, 'p-install-1')
  assert.equal(node.kind, 'one-to-many')
  assert.deepEqual(node.edges.map((e) => e.targetId).sort(), ['p-install-1', 'p-install-2'])
  assert.ok(node.edges.every((e) => e.group === 'g-install'))
})

test('chapter reorder between versions does not rely on array indexes', () => {
  const api = fresh()
  const v100 = api.getContent('components/button', { lang: 'en', sourceVersion: '1.0.0' })
  const v110 = api.getContent('components/button', { lang: 'en', sourceVersion: '1.1.0' })
  // install was index 4th section in 1.0.0, 1st in 1.1.0 — still mapped by id
  assert.equal(v100.sourceVersion.segments[0].id, 'h-usage')
  assert.equal(v110.sourceVersion.segments[0].id, 'h-install')
  const edge = v110.graph.edges.find((e) => e.sourceId === 'h-install')
  assert.equal(edge.targetId, 'h-install')
  // structural hash must differ because order changed
  assert.notEqual(v100.baselines.structural, v110.baselines.structural)
})

test('folded proposals produce tentative edges until human confirms', () => {
  const doc = {
    ...buttonDoc,
    edgesByVersion: {
      ...buttonDoc.edgesByVersion,
      '9.9.9': []
    },
    versions: [...buttonDoc.versions, {
      version: '9.9.9', createdAt: 'x',
      segments: [{ id: 'solo', tokens: [{ kind: 'text', text: 'solo' }] }]
    }],
    units: [...buttonDoc.units, { id: 'solo', lang: 'en', tokens: [{ kind: 'text', text: 'solo en' }] }]
  }
  const store = createStore({ ...seed, docs: [doc] })
  store.proposals.push({
    id: 'px', docId: doc.id, targetLang: 'en', sourceVersion: '9.9.9',
    sourceId: 'solo', targetId: 'solo', type: 'map', status: 'approved', author: 'a'
  })
  const api = createContentApi(store)
  const c = api.getContent(doc.id, { lang: 'en', sourceVersion: '9.9.9' })
  const edge = c.graph.edges.find((e) => e.sourceId === 'solo')
  assert.ok(edge, 'approved proposal folded into graph')
  assert.equal(edge.status, 'tentative', 'folded edge awaits confirmation')
})
