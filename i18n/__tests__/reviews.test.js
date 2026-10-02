import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store/createStore.js'
import { seed, installationDoc } from '../fixtures/seed.js'
import { submitReview, decideProposal } from '../core/reviews.js'

test('two translators editing same unit: stale base revision gets 409', () => {
  const store = createStore(seed) // p-install seeded at revision 2 by reviewer-b
  const first = submitReview(store, {
    docId: installationDoc.id, lang: 'en', unitId: 'p-install',
    expectedRevision: 2, translationHash: 'h-new-b', sourceDocVersion: '1.1.0',
    sourceHash: 'x', reviewer: 'reviewer-b'
  })
  assert.equal(first.status, 200)
  assert.equal(first.review.revision, 3)

  // reviewer-a still holds revision 1 -> conflict, no overwrite
  const clash = submitReview(store, {
    docId: installationDoc.id, lang: 'en', unitId: 'p-install',
    expectedRevision: 1, translationHash: 'h-stale-a', sourceDocVersion: '1.0.0',
    sourceHash: 'y', reviewer: 'reviewer-a'
  })
  assert.equal(clash.status, 409)
  assert.equal(clash.error.code, 'revision-conflict')
  assert.deepEqual(clash.error.resolution, ['overwrite', 'rebase', 'open-diff'])
  // stored value must remain the winning commit
  const kept = store.reviews[`${installationDoc.id}::en::p-install`]
  assert.equal(kept.translationHash, 'h-new-b')
  assert.equal(kept.reviewer, 'reviewer-b')
  // history retained the superseded row
  assert.ok(store.history.some((h) => h.unitId === 'p-install' && h.revision === 2))
})

test('first-ever review without expected revision creates revision 1', () => {
  const store = createStore(seed)
  const r = submitReview(store, {
    docId: 'components/button', lang: 'en', unitId: 'p-perf',
    translationHash: 'h', sourceHash: 's', sourceDocVersion: '1.2.0',
    reviewer: 'newcomer'
  })
  assert.equal(r.status, 200)
  assert.equal(r.review.revision, 1)
})

test('proposal decision workflow: approve then reject is 409', () => {
  const store = createStore(seed)
  const ok = decideProposal(store, 'prop-1', 'approved', 'editor')
  assert.equal(ok.status, 200)
  assert.equal(ok.proposal.status, 'approved')
  const again = decideProposal(store, 'prop-1', 'rejected', 'editor')
  assert.equal(again.status, 409)
  assert.equal(again.error.code, 'already-decided')
})
