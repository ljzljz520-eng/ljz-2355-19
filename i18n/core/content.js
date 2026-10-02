// Content API core — implementation shared by the HTTP server (server/index.js)
// and the static VitePress reader (imports fixtures directly).
//
// Routes (HTTP adapter in server/index.js):
//   GET  /docs                      -> document index
//   GET  /docs/:id                  -> document metadata + versions + available languages
//   GET  /docs/:id/content?lang=&sourceVersion=
//        -> source version, target units, ALIGNMENT GRAPH (never positional),
//           edge states, conflicts, freshness banner data
//   GET  /docs/:id/history/:version?lang=  -> historical archive snapshot
//   POST /reviews                   -> review/verify a unit (If-Match revision)
//   POST /proposals/:id/decision    -> human confirmation entry for conflicts
//   POST /search?q=                 -> hits incl. docVersion so readers can
//                                      open the exact historical version

import { buildGraph, foldGraph, describeLockVsGraph } from './graph.js'
import { computeEdgeStates, stateSummary, detectAlignmentConflicts } from './status.js'
import { buildBaselines } from './hash.js'

export function createContentApi(store) {
  function getDoc(id) {
    return store.docs.find((d) => d.id === id) || null
  }

  function resolveVersion(doc, version) {
    if (version) return doc.versions.find((v) => v.version === version) || null
    return [...doc.versions].sort(compareVersions).at(-1)
  }

  function listLanguages(doc) {
    const translated = [...new Set((doc.units || []).map((u) => u.lang))]
    return doc.languages.map((lang) => ({
      lang,
      available: translated.includes(lang),
      // A language "暂缺" is reported explicitly instead of 404ing the page.
      status: translated.includes(lang) ? 'available' : 'missing'
    }))
  }

  function getContent(docId, { lang, sourceVersion, foldProposals = true } = {}) {
    const doc = getDoc(docId)
    if (!doc) return { status: 404, error: { code: 'doc-not-found' } }

    const source = resolveVersion(doc, sourceVersion)
    if (!source) return { status: 404, error: { code: 'version-not-found' } }

    const languages = listLanguages(doc)
    if (lang) {
      const langInfo = languages.find((l) => l.lang === lang)
      if (!langInfo) return { status: 404, error: { code: 'lang-not-supported', languages } }
      if (langInfo.status === 'missing') {
        return {
          status: 200,
          doc: meta(doc),
          sourceVersion: publicVersion(source, store.registry),
          targetLang: lang,
          targetAvailable: false,
          missing: { lang, reason: doc.missingReason?.[lang] || 'translation-not-started' },
          units: [],
          graph: { edges: [] },
          states: [],
          summary: stateSummary([]),
          conflicts: [],
          lockVsGraph: null,
          baselines: buildBaselines(source, store.registry)
        }
      }
    }

    let graph = buildGraph(doc, source, lang)
    let openProposals = (store.proposals || []).filter(
      (p) => p.docId === docId && p.targetLang === lang && p.sourceVersion === source.version
    )
    const conflicts = detectAlignmentConflicts({
      doc, sourceVersion: source, graph, proposals: store.proposals, targetLang: lang
    })
    if (foldProposals) graph = foldGraph(graph, openProposals)

    // annotate segments with their containing doc version for status compare
    const annotated = {
      ...source,
      segments: source.segments.map((s) => ({ ...s, __docVersion: source.version }))
    }
    const states = lang
      ? computeEdgeStates({
          doc, sourceVersion: annotated, graph, registry: store.registry, reviews: reviewList()
        })
      : []

    const targetUnits = lang
      ? (doc.units || []).filter((u) => u.lang === lang)
      : []

    return {
      status: 200,
      doc: meta(doc),
      sourceVersion: publicVersion(source, store.registry),
      targetLang: lang || null,
      targetAvailable: true,
      latestSourceVersion: latestVersionString(doc),
      isHistorical: source.version !== latestVersionString(doc),
      units: targetUnits.map((u) => publicUnit(u, store.registry)),
      graph,
      states,
      summary: stateSummary(states),
      conflicts,
      openProposals: openProposals.map(publicProposal),
      lockVsGraph: lang ? describeLockVsGraph(doc, graph, source) : null,
      baselines: buildBaselines(source, store.registry)
    }
  }

  // Historical archive: always labelled as such, never merged with "current".
  function getHistory(docId, version, lang) {
    const body = getContent(docId, { lang, sourceVersion: version })
    if (body.status !== 200) return body
    return {
      ...body,
      archive: {
        requestedVersion: version,
        latestVersion: latestVersionString(getDoc(docId)),
        note: 'frozen archive: states reflect this source version, not current docs'
      }
    }
  }

  function reviewList() {
    return Object.values(store.reviews || {})
  }

  function index() {
    return store.docs.map(meta)
  }

  return {
    store,
    index,
    getDoc,
    getContent,
    getHistory,
    listLanguages,
    reviewList,
    resolveVersion
  }
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

function latestVersionString(doc) {
  return [...doc.versions].sort((x, y) => compareVersions(x.version, y.version)).at(-1).version
}

function meta(doc) {
  return {
    id: doc.id,
    title: doc.title,
    languages: doc.languages,
    versions: doc.versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      note: v.note || null
    })),
    lock: doc.lock || null
  }
}

// Target units never embed shared code bodies; references resolve at render.
function publicUnit(unit, registry) {
  if (unit.type === 'code-ref') {
    const code = registry.code?.[unit.ref]
    return {
      id: unit.id,
      lang: unit.lang,
      type: 'code-ref',
      ref: unit.ref,
      resolvedVersion: code?.version ?? null,
      resolvedLanguage: code?.language ?? null,
      // preview only; the source of truth remains the registry entry
      preview: code ? renderReference(unit.ref, registry) : null
    }
  }
  return { ...unit }
}

function publicVersion(version, registry) {
  return {
    ...version,
    segments: version.segments.map((s) => {
      if (s.type === 'code-ref') {
        const code = registry.code?.[s.ref]
        return { ...s, resolvedVersion: code?.version ?? null, resolvedLanguage: code?.language ?? null }
      }
      return { ...s }
    })
  }
}

function publicProposal(p) {
  return {
    id: p.id, sourceId: p.sourceId, targetId: p.targetId, type: p.type,
    kind: p.kind, group: p.group || null, status: p.status, author: p.author,
    reason: p.reason || null
  }
}

// Shared render: code references, parameter names and do-not-translate
// literals are resolved from ONE registry for every language. The translation
// never carries its own copy, so a code update cannot fork versions.
export function renderReference(ref, registry) {
  const [kind] = ref.split(':')
  if (kind === 'code') {
    const e = registry.code?.[ref]
    return e ? { kind: 'code', language: e.language, filename: e.filename, body: e.body } : null
  }
  if (kind === 'param') {
    const e = registry.params?.[ref]
    return e ? { kind: 'param', name: e.name, doNotTranslate: true } : null
  }
  if (kind === 'lit') {
    const e = registry.literals?.[ref]
    return e ? { kind: 'literal', text: e.text, doNotTranslate: true } : null
  }
  return null
}

