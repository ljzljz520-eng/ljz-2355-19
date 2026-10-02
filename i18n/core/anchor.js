// Semantic-anchor mapping for chapter reordering and historical versions.
// Scroll position survives because we anchor on a *paragraph identity*,
// resolving across versions in order:
//   1. stable segment id (carried by unchanged / moved paragraphs)
//   2. heading id + ordinal within the section (paragraph inserted/deleted)
//   3. content-similarity fallback (paragraph was rewritten but kept its place)
// Never falls back to a raw pixel offset — that is exactly how index-based
// alignment breaks.

export function headingIndex(version) {
  const idx = new Map()
  for (const seg of version.segments) {
    if (seg.type === 'heading') idx.set(seg.id, seg)
  }
  return idx
}

function tokensText(seg) {
  if (typeof seg.text === 'string') return seg.text
  return (seg.tokens || []).filter((t) => t.kind === 'text').map((t) => t.text).join(' ')
}

// Character n-gram Jaccard — language-agnostic similarity for the fallback.
function ngrams(str, n = 2) {
  const s = str.replace(/\s+/g, '').toLowerCase()
  const set = new Set()
  for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n))
  return set
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export function remapAnchor(anchor, fromVersion, toVersion, { threshold = 0.45 } = {}) {
  // 1. stable id
  const byId = new Map(toVersion.segments.map((s) => [s.id, s]))
  if (byId.has(anchor.segmentId)) {
    return { segmentId: anchor.segmentId, matchedBy: 'stable-id', confidence: 1 }
  }

  // 2. heading + ordinal
  const fromSeg = fromVersion.segments.find((s) => s.id === anchor.segmentId)
  if (fromSeg) {
    const headingOf = (version, segId) => {
      let heading = null, ordinal = 0
      for (const s of version.segments) {
        if (s.type === 'heading') { heading = s.id; ordinal = 0 }
        else if (heading) ordinal++
        if (s.id === segId) return { heading, ordinal }
      }
      return null
    }
    const loc = headingOf(fromVersion, anchor.segmentId)
    if (loc?.heading && byId.has(loc.heading)) {
      let heading = null, ordinal = 0
      for (const s of toVersion.segments) {
        if (s.type === 'heading') { heading = s.id; ordinal = 0; continue }
        if (heading === loc.heading && ordinal === loc.ordinal) {
          return { segmentId: s.id, matchedBy: 'heading-ordinal', confidence: 0.75 }
        }
        if (heading) ordinal++
      }
    }

    // 3. content similarity within same heading scope
    const candidateText = tokensText(fromSeg)
    let best = null, bestScore = threshold
    for (const s of toVersion.segments) {
      if (s.type !== fromSeg.type) continue
      const score = jaccard(ngrams(candidateText), ngrams(tokensText(s)))
      if (score > bestScore) { best = s; bestScore = score }
    }
    if (best) return { segmentId: best.id, matchedBy: 'content-similarity', confidence: bestScore }
  }
  return { segmentId: null, matchedBy: 'none', confidence: 0 }
}

// Resolve a semantic scroll anchor {segmentId, ratioInside} to a scrollY value
// inside a rendered pane DOM node. Pure enough to unit-test with a fake node.
export function resolveScrollPosition(container, segmentEl, anchor) {
  if (!segmentEl) return null
  const top = segmentEl.offsetTop - container.offsetTop
  const ratio = Math.min(1, Math.max(0, anchor.ratioInside ?? 0))
  return top + segmentEl.offsetHeight * ratio
}

export function captureAnchor(container, segmentEl) {
  if (!segmentEl) return null
  const overflow = container.scrollTop - (segmentEl.offsetTop - container.offsetTop)
  const ratio = segmentEl.offsetHeight ? overflow / segmentEl.offsetHeight : 0
  return {
    segmentId: segmentEl.dataset.segmentId,
    ratioInside: Math.min(1, Math.max(0, ratio))
  }
}
