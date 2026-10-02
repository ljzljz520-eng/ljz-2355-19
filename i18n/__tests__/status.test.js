import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store/createStore.js'
import { seed } from '../fixtures/seed.js'
import { createContentApi } from '../core/content.js'
import { buildBaselines, segmentHash } from '../core/hash.js'

const stateOf = (c, id) => c.states.find((s) => s.sourceId === id)?.state

test('unchanged paragraphs keep verified status after other paragraphs were edited', () => {
  const api = createContentApi(createStore(seed))
  const c120 = api.getContent('components/button', { lang: 'en', sourceVersion: '1.2.0' })
  // 1.2.0 only edits p-install-1; h-usage/p-intro/h-api untouched since 1.1.0
  assert.equal(stateOf(c120, 'h-usage'), 'confirmed')
  assert.equal(stateOf(c120, 'h-api'), 'confirmed')
  // the edited one flips to needs-review
  assert.equal(stateOf(c120, 'p-install-1'), 'needs-review')
  assert.equal(c120.summary.inSync, false)
})

test('original edit flips only the affected edge to needs-review', () => {
  const api = createContentApi(createStore(seed))
  const c110 = api.getContent('components/button', { lang: 'en', sourceVersion: '1.1.0' })
  assert.equal(stateOf(c110, 'p-intro'), 'needs-review')
  assert.equal(stateOf(c110, 'h-install'), 'confirmed') // heading unchanged
})

test('baseline hash changes on a single character edit', () => {
  const api = createContentApi(createStore(seed))
  const v110 = api.resolveVersion(api.getDoc('components/button'), '1.1.0')
  const v120 = api.resolveVersion(api.getDoc('components/button'), '1.2.0')
  const b1 = buildBaselines(v110, seed.registry).segments['p-install-1']
  const b2 = buildBaselines(v120, seed.registry).segments['p-install-1']
  assert.notEqual(b1, b2)
  // a paragraph identical across versions keeps the same hash
  const h1 = buildBaselines(v110, seed.registry).segments['h-usage']
  const h2 = buildBaselines(v120, seed.registry).segments['h-usage']
  assert.equal(h1, h2)
})

test('code update flags code-ref-changed without copying code into translation', () => {
  const api = createContentApi(createStore(seed))
  const c = api.getContent('components/button', { lang: 'en', sourceVersion: '1.0.0' })
  const st = stateOf(c, 'c-demo-button')
  assert.equal(st, 'code-ref-changed')
  // translation unit must only carry the ref, never a body copy
  const unit = c.units.find((u) => u.id === 'c-demo-button')
  assert.equal(unit.type, 'code-ref')
  assert.equal(unit.ref, 'code:demo-button')
  assert.equal(unit.resolvedVersion, 2)
  assert.equal(unit.preview.body.includes('Small'), true, 'resolves live from registry')
  assert.ok(!('body' in unit), 'no duplicated body field on the unit')
})

test('shared refs (params/literals) render identically in both languages', () => {
  const api = createContentApi(createStore(seed))
  const c = api.getContent('components/button', { lang: 'en', sourceVersion: '1.2.0' })
  const enApi = c.units.find((u) => u.id === 'p-api')
  assert.ok(enApi.tokens.some((k) => k.kind === 'param' && k.ref === 'param:type'))
  // zh and en reference the same registry id
  const zh = c.sourceVersion.segments.find((s) => s.id === 'p-api')
  assert.ok(zh.tokens.some((k) => k.kind === 'param' && k.ref === 'param:type'))
})

test('language missing is explicit, not a 404 or fake sync', () => {
  const api = createContentApi(createStore(seed))
  const c = api.getContent('components/tag', { lang: 'en' })
  assert.equal(c.status, 200)
  assert.equal(c.targetAvailable, false)
  assert.equal(c.missing.reason, 'translation-not-started')
  assert.equal(c.summary.inSync, false)
  const langs = api.listLanguages(api.getDoc('components/tag'))
  assert.equal(langs.find((l) => l.lang === 'en').status, 'missing')
})

test('whole-document stale lock is reported honestly vs paragraph graph', () => {
  const api = createContentApi(createStore(seed))
  const c = api.getContent('guide/installation', { lang: 'en', sourceVersion: '1.1.0' })
  assert.equal(c.lockVsGraph.lockBaseline, '1.0.0')
  assert.equal(c.lockVsGraph.currentSourceVersion, '1.1.0')
  assert.equal(c.lockVsGraph.lockMatchesCurrent, false)
  assert.equal(c.lockVsGraph.lockFullyConsistent, false)
  assert.equal(c.lockVsGraph.graphMode, 'locked')
  // viewing the locked baseline itself is consistent
  const old = api.getContent('guide/installation', { lang: 'en', sourceVersion: '1.0.0' })
  assert.equal(old.lockVsGraph.lockFullyConsistent, true)
})

test('conflicts detected: source-missing, target-missing, duplicate-target, proposals', () => {
  const api = createContentApi(createStore(seed))
  const c = api.getContent('components/button', { lang: 'en', sourceVersion: '1.1.0' })
  const codes = c.conflicts.map((x) => x.code)
  assert.ok(codes.includes('source-missing'))
  assert.ok(codes.includes('target-missing'))
  assert.ok(codes.includes('duplicate-target'))
  assert.ok(codes.includes('competing-proposal'))
  assert.ok(codes.includes('dangling-unmap'))
})
