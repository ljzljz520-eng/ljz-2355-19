// Version-aware search. Every hit carries docVersion + segmentId, so opening a
// result lands in the HISTORICAL version the text was matched in — and the
// reader banner states that explicitly instead of showing current content
// labelled with old wording.

import { createContentApi } from './content.js'

function segmentPlainText(seg, registry) {
  if (seg.type === 'heading') return seg.text || ''
  if (seg.type === 'code-ref') {
    const c = registry.code?.[seg.ref]
    return c ? `${c.filename || ''} ${c.body || ''}` : ''
  }
  return (seg.tokens || [])
    .map((t) => {
      if (t.kind === 'text') return t.text
      const resolved = t.ref && t.ref.startsWith('param:')
        ? registry.params?.[t.ref]?.name
        : t.ref?.startsWith('lit:') ? registry.literals?.[t.ref]?.text : ''
      return resolved || ''
    })
    .join(' ')
}

export function buildSearchIndex(store) {
  const api = createContentApi(store)
  const hits = []
  for (const doc of store.docs) {
    for (const v of doc.versions) {
      // source side
      for (const seg of v.segments) {
        hits.push({
          docId: doc.id, docTitle: doc.title, lang: doc.sourceLang || 'zh',
          docVersion: v.version, segmentId: seg.id,
          heading: seg.type === 'heading',
          text: segmentPlainText(seg, store.registry)
        })
      }
      // translation side (units map to CURRENT edges; older units still indexed
      // historically via unit.versions)
      for (const unit of doc.units || []) {
        const text = unit.type === 'code-ref'
          ? store.registry.code?.[unit.ref]?.body || ''
          : segmentPlainText(unit, store.registry)
        hits.push({
          docId: doc.id, docTitle: doc.title, lang: unit.lang,
          docVersion: v.version, segmentId: unit.id, unitId: unit.id,
          heading: unit.type === 'heading', text
        })
      }
    }
  }
  return { hits }
}

export function search(index, query, { lang, limit = 20 } = {}) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const scored = []
  for (const h of index.hits) {
    if (lang && h.lang !== lang) continue
    const text = h.text.toLowerCase()
    const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0)
    if (score === 0) continue
    scored.push({
      ...h,
      score: score + (h.heading ? 0.5 : 0),
      snippet: makeSnippet(h.text, terms[0])
    })
  }
  scored.sort((a, b) => b.score - a.score)
  // Deduplicate identical (doc,unit) keeping the newest version hit first;
  // but historical matches are NEVER discarded — they open archives.
  return scored.slice(0, limit)
}

function makeSnippet(text, term) {
  const i = text.toLowerCase().indexOf(term)
  if (i < 0) return text.slice(0, 80)
  const start = Math.max(0, i - 30)
  return (start > 0 ? '…' : '') + text.slice(start, i + 60) + '…'
}

// Resolve a search hit to the exact reader route params.
export function hitRoute(hit) {
  return {
    docId: hit.docId,
    lang: hit.lang,
    sourceVersion: hit.docVersion,
    segmentId: hit.unitId || hit.segmentId,
    historical: true
  }
}
