// Assembles the full seed. Baseline hashes are computed with the core hashing
// functions (never hand-written) so fixtures genuinely represent "reviewed
// against THIS exact source text / THIS exact code version".

import { hashSegment, hashCodeRef, segmentHash } from '../core/hash.js'
import { buttonDoc } from './docs/button.js'
import { installationDoc } from './docs/installation.js'
import { tagDoc } from './docs/tag.js'
import { registry } from './registry.js'

function findSeg(doc, version, id) {
  return doc.versions.find((v) => v.version === version).segments.find((s) => s.id === id)
}
function findUnit(doc, lang, id) {
  return doc.units.find((u) => u.lang === lang && u.id === id)
}

function review(doc, version, unitId, reviewer = 'reviewer-a', extra = {}) {
  const seg = findSeg(doc, version, extra.sourceId || unitId)
  const unit = findUnit(doc, 'en', unitId)
  const isCode = seg?.type === 'code-ref'
  return {
    docId: doc.id,
    lang: 'en',
    unitId,
    sourceDocVersion: version,
    sourceHash: isCode ? hashCodeRef(seg.ref, registry) : segmentHash(seg),
    translationHash: isCode
      ? `code@${extra.codeVersion ?? 1}`
      : segmentHash(unit),
    codeVersion: isCode ? extra.codeVersion ?? 1 : null,
    reviewer,
    status: 'verified',
    revision: extra.revision ?? 1,
    updatedAt: '2026-08-06T10:00:00.000Z'
  }
}

const reviews = [
  // ---- button 1.0.0: fully reviewed English baseline ----
  review(buttonDoc, '1.0.0', 'h-usage'),
  review(buttonDoc, '1.0.0', 'p-intro'),
  review(buttonDoc, '1.0.0', 'p-basic-desc'),
  // code demo reviewed while registry code was v1; registry has since moved v2
  review(buttonDoc, '1.0.0', 'c-demo-button', 'reviewer-a', { codeVersion: 1 }),
  review(buttonDoc, '1.0.0', 'h-install'),
  // BOTH halves of the 1:N mapping are reviewed
  review(buttonDoc, '1.0.0', 'p-install-1'),
  review(buttonDoc, '1.0.0', 'p-install-2', 'reviewer-a', { sourceId: 'p-install-1' }),
  review(buttonDoc, '1.0.0', 'h-api'),
  review(buttonDoc, '1.0.0', 'p-api'),
  review(buttonDoc, '1.0.0', 'h-legacy'),
  review(buttonDoc, '1.0.0', 'p-legacy'),
  // ---- installation lock: certified against 1.0.0 ----
  review(installationDoc, '1.0.0', 'h-install'),
  {
    // two translators collided on p-install: reviewer-b's saved revision is 2,
    // while reviewer-a is still editing from revision 1.
    docId: installationDoc.id, lang: 'en', unitId: 'p-install',
    sourceDocVersion: '1.0.0',
    sourceHash: hashSegment(findSeg(installationDoc, '1.0.0', 'p-install').tokens),
    translationHash: hashSegment(findUnit(installationDoc, 'en', 'p-install').tokens),
    codeVersion: null, reviewer: 'reviewer-b', status: 'verified',
    revision: 2, updatedAt: '2026-09-21T09:00:00.000Z'
  }
]

const proposals = [
  // competing proposals on button 1.1.0 p-perf -> p-perf-early:
  // translator A wants to map it, translator B wants to unmap/retranslate
  {
    id: 'prop-1', docId: buttonDoc.id, targetLang: 'en', sourceVersion: '1.1.0',
    sourceId: 'p-perf', targetId: 'p-perf-early', type: 'map', kind: 'one-to-one',
    status: 'pending', author: 'translator-a', reason: 'preview draft is close enough'
  },
  {
    id: 'prop-2', docId: buttonDoc.id, targetLang: 'en', sourceVersion: '1.1.0',
    sourceId: 'p-perf', targetId: 'p-perf-early', type: 'unmap',
    status: 'pending', author: 'translator-b', reason: 'preview wording is misleading'
  },
  // dangling unmap: edge no longer exists
  {
    id: 'prop-3', docId: buttonDoc.id, targetLang: 'en', sourceVersion: '1.1.0',
    sourceId: 'p-intro', targetId: 'p-removed', type: 'unmap',
    status: 'pending', author: 'translator-a', reason: 'cleanup'
  }
]

export const seed = {
  docs: [buttonDoc, installationDoc, tagDoc],
  registry,
  reviews,
  proposals
}

export { buttonDoc, installationDoc, tagDoc }
