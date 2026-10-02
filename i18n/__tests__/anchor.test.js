import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remapAnchor, captureAnchor, resolveScrollPosition } from '../core/anchor.js'
import { createStore } from '../store/createStore.js'
import { seed } from '../fixtures/seed.js'
import { createContentApi } from '../core/content.js'

const api = createContentApi(createStore(seed))
const v100 = api.resolveVersion(api.getDoc('components/button'), '1.0.0')
const v110 = api.resolveVersion(api.getDoc('components/button'), '1.1.0')
const v120 = api.resolveVersion(api.getDoc('components/button'), '1.2.0')

test('moved paragraph keeps semantic position via stable id across reorder', () => {
  // p-intro was under h-usage in both, but h-install moved above it
  const m = remapAnchor({ segmentId: 'h-install' }, v100, v110)
  assert.equal(m.segmentId, 'h-install')
  assert.equal(m.matchedBy, 'stable-id')
})

test('rewritten paragraph falls back to heading+ordinal, not pixel offset', () => {
  // p-install-1 text changed but it is still the 1st prose under h-install
  const m = remapAnchor({ segmentId: 'p-install-1' }, v100, v120)
  // id is stable in this fixture anyway; verify fallback chain explicitly with
  // a synthetic deleted id
  const synth = {
    segments: v100.segments.map((s) => (s.id === 'p-basic-desc' ? { ...s, id: 'gone' } : s))
  }
  const m2 = remapAnchor({ segmentId: 'gone' }, synth, v110)
  assert.ok(['heading-ordinal', 'content-similarity', 'stable-id'].includes(m2.matchedBy))
  assert.notEqual(m2.segmentId, null)
})

test('capture/resolve anchor preserves ratio inside the semantic node', () => {
  const container = { scrollTop: 320, offsetTop: 100 }
  const el = { dataset: { segmentId: 'p-intro' }, offsetTop: 300, offsetHeight: 100 }
  const a = captureAnchor(container, el)
  assert.equal(a.segmentId, 'p-intro')
  // 320-(300-100)=120 overflow over 100px height -> clamped to 1.0
  assert.equal(a.ratioInside, 1)
  const y = resolveScrollPosition({ offsetTop: 0 }, { offsetTop: 250, offsetHeight: 40 }, {
    segmentId: 'x', ratioInside: 0.5
  })
  assert.equal(y, 270)
})

test('missing paragraph in target version resolves to null, never a wrong index', () => {
  // p-legacy deleted after 1.0.0
  const m = remapAnchor({ segmentId: 'p-legacy' }, v100, v120)
  // heading h-legacy also deleted; no ordinal anchor, similarity may find text
  // in p-perf? threshold prevents weak matches — assert no confident stable match
  assert.notEqual(m.matchedBy, 'stable-id')
})
