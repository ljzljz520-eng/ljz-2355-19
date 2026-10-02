// Paragraph-level alignment graph.
//
// Why not array indexes? Chinese paragraphs are frequently split or merged in
// English ("一对多"). Index alignment silently drifts the moment one side is
// edited. Instead every correspondence is an explicit, labelled EDGE:
//
//   { id, sourceId, targetId, kind: 'one-to-one'|'one-to-many'|'many-to-one',
//     group, baselineDocVersion }
//
// 1:N example: source [p-install-1] -> targets [p-install-1, p-install-2]
// share a `group`, so scroll-sync and reviews treat them as one semantic node.
//
// Edges are pinned to the SOURCE version they were aligned against. A new
// source version proposes new edges; old edges survive for historical views.

const EDGE_KINDS = new Set(['one-to-one', 'one-to-many', 'many-to-one'])

export function buildGraph(doc, sourceVersion, targetLang, { autoOneToOne = true } = {}) {
  const sources = sourceVersion.segments
  const units = (doc.units || []).filter((u) => u.lang === targetLang)
  const edges = []
  const explicit = new Set()

  const addEdge = (e) => {
    if (!EDGE_KINDS.has(e.kind)) throw new Error(`bad edge kind: ${e.kind}`)
    edges.push({
      id: e.id || `edge-${e.sourceId}-${e.targetId}`,
      sourceId: e.sourceId,
      targetId: e.targetId,
      kind: e.kind,
      group: e.group || (e.kind === 'one-to-one' ? undefined : e.sourceId),
      baselineDocVersion: e.baselineDocVersion || sourceVersion.version,
      status: e.status || 'confirmed'
    })
    explicit.add(`${e.sourceId}=>${e.targetId}`)
  }

  for (const e of doc.edgesByVersion?.[sourceVersion.version] || []) addEdge(e)

  // Default 1:1 ONLY between structurally matched ids that were not explicitly
  // mapped — a convenience for fresh docs, never a positional assumption: the
  // match is on stable segment ids, not on array order.
  if (autoOneToOne) {
    for (const s of sources) {
      const u = units.find((x) => x.id === s.id)
      if (u && !explicit.has(`${s.id}=>${u.id}`)) {
        addEdge({
          sourceId: s.id,
          targetId: u.id,
          kind: 'one-to-one',
          baselineDocVersion: sourceVersion.version,
          status: 'tentative'
        })
      }
    }
  }
  return {
    docId: doc.id,
    sourceVersion: sourceVersion.version,
    targetLang,
    edges
  }
}

export function edgesBySource(graph) {
  const m = new Map()
  for (const e of graph.edges) {
    if (!m.has(e.sourceId)) m.set(e.sourceId, [])
    m.get(e.sourceId).push(e)
  }
  return m
}

export function edgesByTarget(graph) {
  const m = new Map()
  for (const e of graph.edges) m.set(e.targetId, e)
  return m
}

// Semantic node for a source paragraph = itself + every target joined by the
// same group (1:N). This is the unit the two-pane reader highlights/scrolls.
export function semanticNode(graph, sourceId) {
  const direct = graph.edges.filter((e) => e.sourceId === sourceId)
  if (!direct.length) return { sourceId, edges: [], group: null, kind: 'untranslated' }
  const group = direct[0].group
  const siblings = group
    ? graph.edges.filter((e) => e.kind !== 'one-to-one' && e.group === group)
    : direct
  const kind = siblings.length > 1 ? 'one-to-many' : siblings[0].kind
  return { sourceId, group, kind, edges: siblings }
}

// Apply pending mapping proposals to a working copy of a graph (manual
// confirmation entry). foldGraph does NOT mutate review state — proposals only
// become confirmed edges once a reviewer confirms them (see reviews.js).
export function foldGraph(graph, proposals) {
  const folded = { ...graph, edges: graph.edges.map((e) => ({ ...e })) }
  for (const p of proposals || []) {
    if (p.status !== 'approved') continue
    if (p.type === 'map') {
      const exists = folded.edges.some(
        (e) => e.sourceId === p.sourceId && e.targetId === p.targetId
      )
      if (!exists) {
        const groupSize = (p.group &&
          folded.edges.filter((e) => e.group === p.group).length) || 0
        folded.edges.push({
          id: p.id || `edge-${p.sourceId}-${p.targetId}`,
          sourceId: p.sourceId,
          targetId: p.targetId,
          kind: groupSize >= 1 || p.kind === 'one-to-many' ? 'one-to-many' : p.kind || 'one-to-one',
          group: p.group || (p.kind === 'one-to-many' ? p.sourceId : undefined),
          baselineDocVersion: graph.sourceVersion,
          status: 'tentative'
        })
      }
    } else if (p.type === 'unmap') {
      folded.edges = folded.edges.filter(
        (e) => !(e.sourceId === p.sourceId && e.targetId === p.targetId)
      )
    }
  }
  return normalizeKinds(folded)
}

// Re-derive kinds from group membership after edits.
export function normalizeKinds(graph) {
  const groups = new Map()
  for (const e of graph.edges) {
    if (e.kind === 'one-to-one') continue
    const key = e.group || e.sourceId
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  for (const [, members] of groups) {
    if (members.length > 1) members.forEach((m) => (m.kind = 'one-to-many'))
  }
  return graph
}

// "Whole-document language lock": one baseline for the entire translation.
// Compare it against a paragraph graph: returns which claim the data supports.
export function describeLockVsGraph(doc, graph, currentSource) {
  const edgeVersions = new Set(graph.edges.map((e) => e.baselineDocVersion))
  const locked = doc.lock?.[graph.targetLang]
  return {
    lockBaseline: locked?.docVersion || null,
    currentSourceVersion: currentSource.version,
    edgeBaselines: [...edgeVersions].sort(),
    lockMatchesCurrent: locked?.docVersion === currentSource.version,
    // The lock is only truthful if EVERY edge agrees with it AND it equals the
    // current source. A stale lock must render as "translated against vX",
    // never repackaged as fully in sync.
    lockFullyConsistent:
      locked?.docVersion === currentSource.version &&
      edgeVersions.size <= 1 &&
      (edgeVersions.size === 0 || edgeVersions.has(currentSource.version)),
    graphMode: locked ? 'locked' : 'paragraph',
    paragraphGraphAllowsPartial: !locked
  }
}
