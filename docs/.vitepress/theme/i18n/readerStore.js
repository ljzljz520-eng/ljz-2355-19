// Browser-side reader store: runs the SAME core logic as the HTTP API on the
// shipped fixture seed. In production this module becomes a thin fetch()
// client against /api/i18n/* (same response shapes — see server/index.js).

import { createContentApi } from '../../../../i18n/core/content.js'
import { createStore } from '../../../../i18n/store/createStore.js'
import { seed } from '../../../../i18n/fixtures/seed.js'
import { buildSearchIndex, search } from '../../../../i18n/core/search.js'
import { submitReview, decideProposal } from '../../../../i18n/core/reviews.js'
import { renderReference } from '../../../../i18n/core/content.js'
import { hashSegment, segmentHash } from '../../../../i18n/core/hash.js'
import { remapAnchor } from '../../../../i18n/core/anchor.js'

const store = createStore(seed)
const api = createContentApi(store)
const index = buildSearchIndex(store)

export function listDocs() {
  return api.index()
}

export function loadBilingual(docId, { lang = 'en', sourceVersion } = {}) {
  return api.getContent(docId, { lang, sourceVersion })
}

export function loadHistory(docId, version, lang) {
  return api.getHistory(docId, version, lang)
}

export function resolveVersion(docId, v) {
  const doc = api.getDoc(docId)
  return doc ? api.resolveVersion(doc, v) : null
}

export function runSearch(q, lang) {
  return search(index, q, { lang: lang || undefined })
}

// Save a reviewer's verification. expectedRevision implements If-Match in the
// browser too: two translators collide here exactly like the HTTP 409 path.
export function saveReview(input) {
  const doc = api.getDoc(input.docId)
  const version = api.resolveVersion(doc, input.sourceDocVersion)
  const seg = version.segments.find((s) => s.id === input.sourceId)
  return submitReview(store, {
    ...input,
    translationHash: input.tokens ? hashSegment(input.tokens) : input.translationHash,
    sourceHash: segmentHash(seg, store.registry)
  })
}

export function resolveRef(ref) {
  return renderReference(ref, store.registry)
}

export function getRegistry() {
  return store.registry
}

export function resolveAnchorBetween(docId, fromVersion, toVersion, segmentId) {
  const doc = api.getDoc(docId)
  const from = api.resolveVersion(doc, fromVersion)
  const to = api.resolveVersion(doc, toVersion)
  return remapAnchor({ segmentId }, from, to)
}

export function decideOnProposal(id, decision, reviewer) {
  return decideProposal(store, id, decision, reviewer)
}
