// Review status derivation and alignment conflict detection.
//
// Edge states (priority high -> low):
//   source-missing   edge points at a paragraph removed in current source
//   target-missing   edge points at a translation unit that no longer exists
//   code-ref-changed shared code referenced by the paragraph changed versions
//   needs-review     source baseline differs from edge baseline (original edited)
//   untranslated     source paragraph has no edge at all
//   confirmed        review exists, review text matches stored unit, baseline fresh
//   stale-review     source fresh but the stored translation was edited AFTER review
//   translated       has unit+edge, no review record yet
//
// Crucially, editing one source paragraph only invalidates THAT edge: unchanged
// paragraphs keep `confirmed`. Reviews store a baseline revision; optimistic
// concurrency (If-Match) detects two translators editing the same unit.

import { segmentHash, hashSegment } from './hash.js'
import { edgesBySource, edgesByTarget } from './graph.js'

export function currentBaselines(version, registry) {
  const m = new Map()
  for (const seg of version.segments) m.set(seg.id, segmentHash(seg, registry))
  return m
}

export function computeEdgeStates({ doc, sourceVersion, graph, registry, reviews }) {
  const sourceIds = new Set(sourceVersion.segments.map((s) => s.id))
  const units = new Map(
    (doc.units || []).filter((u) => u.lang === graph.targetLang).map((u) => [u.id, u])
  )
  const baselines = currentBaselines(sourceVersion, registry)
  const bySource = edgesBySource(graph)
  const states = []

  for (const seg of sourceVersion.segments) {
    const edges = bySource.get(seg.id) || []
    if (!edges.length) {
      states.push({ sourceId: seg.id, state: 'untranslated', edges: [] })
      continue
    }
    const edgeStates = edges.map((edge) =>
      classifyEdge({ edge, seg, sourceIds, units, baselines, registry, reviews, doc, lang: graph.targetLang })
    )
    // Paragraph state is the worst of its 1:N members; confirmed only if all are.
    const rank = rankStates(edgeStates.map((e) => e.state))
    states.push({ sourceId: seg.id, state: rank, edges: edgeStates })
  }

  // Orphan edges whose source vanished from the current version: the "来源缺失"
  // case — reviewer must unmap or keep them attached to a historical version.
  for (const edge of graph.edges) {
    if (!sourceIds.has(edge.sourceId)) {
      states.push({
        sourceId: edge.sourceId,
        state: 'source-missing',
        edges: [{ edgeId: edge.id, targetId: edge.targetId, state: 'source-missing' }]
      })
    }
  }
  return states
}

function classifyEdge(ctx) {
  const { edge, seg, sourceIds, units, baselines, registry, reviews, doc, lang } = ctx
  const unit = units.get(edge.targetId)
  const base = { edgeId: edge.id, targetId: edge.targetId, sourceId: edge.sourceId }

  if (!unit) return { ...base, state: 'target-missing' }

  // shared-code paragraph: fingerprint is the registry version.
  const currentHash = baselines.get(seg.id)
  if (seg.type === 'code-ref') {
    const entry = registry.code?.[seg.ref]
    if (!entry) return { ...base, state: 'code-ref-missing' }
    if (edge.baselineDocVersion !== seg.__docVersion && edge.baselineDocVersion && entry.version > (edge.__codeVersionAtReview || 0)) {
      // fallthrough; precise code state handled below via reviews
    }
  }

  // Review record lookup.
  const review = (reviews || []).find(
    (r) => r.docId === doc.id && r.lang === lang && r.unitId === edge.targetId
  )

  const sourceChanged = edge.baselineDocVersion !== seg.__docVersion
  const sourceHashAtReview = review?.sourceHash
  const hashNow = currentHash
  const baselineMismatch = sourceHashAtReview && sourceHashAtReview !== hashNow
  const reviewMatchesUnit = review && review.translationHash === hashOfUnit(unit, registry)

  // Code-reference update: the code registry advanced past the reviewed one.
  if (seg.type === 'code-ref') {
    const reviewedCodeVersion = review?.codeVersion
    const currentCodeVersion = registry.code?.[seg.ref]?.version
    if (reviewedCodeVersion != null && currentCodeVersion != null && reviewedCodeVersion < currentCodeVersion) {
      return { ...base, state: 'code-ref-changed', codeVersion: currentCodeVersion, reviewedCodeVersion }
    }
  }

  if (baselineMismatch || (review && sourceChanged)) {
    return { ...base, state: 'needs-review', from: edge.baselineDocVersion, to: seg.__docVersion }
  }
  if (review && !reviewMatchesUnit) return { ...base, state: 'stale-review' }
  if (review) return { ...base, state: 'confirmed', reviewer: review.reviewer }
  return { ...base, state: 'translated' }
}

function hashOfUnit(unit, registry) {
  if (unit.type === 'code-ref') {
    const e = registry.code?.[unit.ref]
    return e ? `code@${e.version}` : 'code@MISSING'
  }
  return hashSegment(unit.tokens || unit.text)
}

function rankStates(states) {
  const order = [
    'source-missing', 'target-missing', 'code-ref-changed', 'code-ref-missing',
    'needs-review', 'stale-review', 'untranslated', 'translated', 'confirmed'
  ]
  let best = 'confirmed'
  for (const s of states) if (order.indexOf(s) < order.indexOf(best)) best = s
  return best
}

export function stateSummary(states) {
  const counts = {}
  for (const s of states) counts[s.state] = (counts[s.state] || 0) + 1
  // No translated paragraphs at all is NOT "in sync" — a missing language must
  // never be vacuously reported as fully synchronized.
  const inSync = states.length > 0 && states.every((s) => s.state === 'confirmed')
  return {
    counts,
    total: states.length,
    inSync,
    // Never claim full sync while ANY edge disagrees with the source version.
    stale: !inSync
  }
}

// ---- Alignment conflict detection ----------------------------------------
// Runs over graph + proposals + both segment sets.  Returns explicit,
// reviewer-addressable problems rather than silently picking a mapping.
export function detectAlignmentConflicts({ doc, sourceVersion, graph, proposals, targetLang }) {
  const conflicts = []
  const sourceIds = new Set(sourceVersion.segments.map((s) => s.id))
  const targetUnits = (doc.units || []).filter((u) => u.lang === targetLang)
  const targetIds = new Set(targetUnits.map((u) => u.id))

  for (const e of graph.edges) {
    if (!sourceIds.has(e.sourceId)) {
      conflicts.push({
        code: 'source-missing',
        severity: 'error',
        edgeId: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        message: `Edge ${e.id} references source paragraph ${e.sourceId}, absent in ${sourceVersion.version}`
      })
    }
    if (!targetIds.has(e.targetId)) {
      conflicts.push({
        code: 'target-missing',
        severity: 'error',
        edgeId: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        message: `Edge ${e.id} targets missing ${targetLang} unit ${e.targetId}`
      })
    }
  }

  // A target unit must have exactly one incoming edge. Two sources claiming
  // the same translation = alignment conflict that needs a human.
  const incoming = new Map()
  for (const e of graph.edges) {
    if (!incoming.has(e.targetId)) incoming.set(e.targetId, [])
    incoming.get(e.targetId).push(e)
  }
  for (const [targetId, es] of incoming) {
    const sources = [...new Set(es.map((e) => e.sourceId))]
    if (sources.length > 1) {
      conflicts.push({
        code: 'duplicate-target',
        severity: 'error',
        targetId,
        sourceIds: sources,
        edgeIds: es.map((e) => e.id),
        message: `Translation ${targetId} is mapped from multiple source paragraphs: ${sources.join(', ')}`
      })
    }
  }

  // Competing proposals: two translators requesting incompatible mappings.
  const pending = (proposals || []).filter((p) => p.status === 'pending')
  const byKey = new Map()
  for (const p of pending) {
    const key = `${p.sourceId}=>${p.targetId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(p)
  }
  for (const [key, ps] of byKey) {
    const types = new Set(ps.map((p) => p.type))
    if (types.size > 1) {
      conflicts.push({
        code: 'competing-proposal',
        severity: 'warning',
        key,
        proposalIds: ps.map((p) => p.id),
        message: `Competing map/unmap proposals on ${key}: ${ps.map((p) => `${p.author}:${p.type}`).join(' vs ')}`
      })
    }
  }
  const unmapOnly = pending.filter(
    (p) => p.type === 'unmap' && !graph.edges.some((e) => e.sourceId === p.sourceId && e.targetId === p.targetId)
  )
  for (const p of unmapOnly) {
    conflicts.push({
      code: 'dangling-unmap',
      severity: 'warning',
      proposalId: p.id,
      message: `Proposal ${p.id} unmaps ${p.sourceId}=>${p.targetId}, but no such edge exists`
    })
  }
  return conflicts
}
