import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveScrollPosition, captureAnchor } from '../core/anchor.js'

// Fake DOM geometry: two panes where the same semantic node sits at very
// different pixel positions (this is why pixel mirroring fails; semantic
// anchoring aligns by node + inner ratio).
test('scroll alignment targets semantic node, not proportional pixels', () => {
  const container = { offsetTop: 0, clientHeight: 400 }
  const zhNode = { dataset: { segmentId: 'p-x' }, offsetTop: 1000, offsetHeight: 200 }
  const enNode = { dataset: { segmentId: 'p-x' }, offsetTop: 120, offsetHeight: 80 }
  // reader at mid-point of the Chinese node...
  const anchor = captureAnchor({ scrollTop: 1100, offsetTop: 0 }, zhNode)
  assert.equal(anchor.segmentId, 'p-x')
  assert.equal(anchor.ratioInside, 0.5)
  // ...right pane scrolls so the English counterpart sits at anchor line
  const y = resolveScrollPosition(container, enNode, anchor)
  assert.equal(y, 120 + 80 * 0.5)
})

test('1:N group maps either English half back to the single Chinese node', () => {
  const edges = [
    { sourceId: 'p-install-1', targetId: 'p-install-1', group: 'g' },
    { sourceId: 'p-install-1', targetId: 'p-install-2', group: 'g' }
  ]
  const groupOf = (id) => {
    const e = edges.find((x) => x.sourceId === id || x.targetId === id)
    if (!e?.group) return null
    // deduped ordered candidates, as the composable iterates them
    return [...new Set(edges.filter((x) => x.group === e.group)
      .flatMap((x) => [x.sourceId, x.targetId]))]
  }
  assert.deepEqual(groupOf('p-install-2'), ['p-install-1', 'p-install-2'])
  assert.deepEqual(groupOf('p-install-1'), ['p-install-1', 'p-install-2'])
})

test('clamped ratio when scrolled past node end', () => {
  const a = captureAnchor(
    { scrollTop: 500, offsetTop: 0 },
    { dataset: { segmentId: 's' }, offsetTop: 100, offsetHeight: 100 }
  )
  assert.equal(a.ratioInside, 1)
})
