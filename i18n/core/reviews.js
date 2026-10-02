// Translation review / baseline persistence (pure logic; storage is injected).
//
// SQL table translation_reviews stores:
//   doc_id, lang, unit_id, translation_hash, source_hash, source_doc_version,
//   code_version, reviewer, status, base_revision, updated_at
// base_revision implements If-Match: two translators editing the same unit
// concurrently — the second commit gets 409 instead of silently overwriting.

import { hashSegment } from './hash.js'

export function buildReviewRecord({
  docId, lang, unit, sourceHash, sourceDocVersion, codeVersion,
  reviewer, baseRevision = null
}) {
  return {
    docId,
    lang,
    unitId: unit.id,
    translationHash: unit.type === 'code-ref' ? `code@${codeVersion}` : hashSegment(unit.tokens || unit.text),
    sourceHash: sourceHash || null,
    sourceDocVersion: sourceDocVersion || null,
    codeVersion: codeVersion ?? null,
    reviewer,
    status: 'verified',
    baseRevision,
    revision: (baseRevision || 0) + 1,
    updatedAt: 'NOW'
  }
}

// Simulated transactional submit against an injected review store.
// Returns { status: 200, review } or a structured error the API maps to HTTP.
export function submitReview(store, input) {
  const { docId, lang, unitId } = input
  const key = `${docId}::${lang}::${unitId}`
  const existing = store.reviews[key]

  if (existing && input.expectedRevision != null &&
      Number(input.expectedRevision) !== Number(existing.revision)) {
    return {
      status: 409,
      error: {
        code: 'revision-conflict',
        message: `Unit ${unitId} was saved by ${existing.reviewer} while you were editing`,
        serverRevision: existing.revision,
        yourBaseRevision: Number(input.expectedRevision),
        // Caller must rebase; we never auto-merge translator prose.
        resolution: ['overwrite', 'rebase', 'open-diff']
      }
    }
  }

  const record = {
    docId,
    lang,
    unitId,
    translationHash: input.translationHash,
    sourceHash: input.sourceHash,
    sourceDocVersion: input.sourceDocVersion,
    codeVersion: input.codeVersion ?? null,
    reviewer: input.reviewer,
    status: input.status || 'verified',
    baseRevision: existing ? existing.revision : null,
    revision: existing ? existing.revision + 1 : 1,
    updatedAt: new Date().toISOString()
  }
  // keep history chain
  store.history = store.history || []
  if (existing) store.history.push({ ...existing, supersededAt: record.updatedAt })
  store.reviews[key] = record
  return { status: 200, review: record }
}

// Confirming an alignment proposal moves it to an edge and stamps the baseline.
export function decideProposal(store, proposalId, decision, reviewer) {
  const p = store.proposals.find((x) => x.id === proposalId)
  if (!p) return { status: 404, error: { code: 'not-found' } }
  if (p.status !== 'pending') {
    return { status: 409, error: { code: 'already-decided', current: p.status, by: p.decidedBy } }
  }
  if (!['approved', 'rejected'].includes(decision)) {
    return { status: 400, error: { code: 'bad-decision' } }
  }
  p.status = decision === 'approved' ? 'approved' : 'rejected'
  p.decidedBy = reviewer
  p.decidedAt = new Date().toISOString()
  return { status: 200, proposal: p }
}
