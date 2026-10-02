// Zero-dependency HTTP adapter over core/content.js.
// Run: node i18n/server/index.js  (defaults to port 5174)
// In production replace createStore(seed) with a SQL-backed store implementing
// the same methods; the response shapes are the API contract.

import http from 'node:http'
import { URL } from 'node:url'
import { createContentApi } from '../core/content.js'
import { createStore } from '../store/createStore.js'
import { seed } from '../fixtures/seed.js'
import { submitReview, decideProposal } from '../core/reviews.js'
import { hashSegment } from '../core/hash.js'
import { buildSearchIndex, search, hitRoute } from '../core/search.js'

export function createI18nServer(initialStore = createStore(seed)) {
  const api = createContentApi(initialStore)
  const searchIndex = buildSearchIndex(initialStore)

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 1e6) reject(new Error('payload-too-large')) })
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('bad-json')) } })
    })

  const send = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(payload, null, 2))
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname.replace(/^\/api\/i18n/, '') || '/'
    const lang = url.searchParams.get('lang') || 'en'
    try {
      // GET /docs
      if (req.method === 'GET' && p === '/docs') return send(res, 200, { docs: api.index() })

      // GET /docs/:id/content?lang=&sourceVersion=  (must precede /docs/:id)
      let m = p.match(/^\/docs\/([\w/-]+)\/content$/)
      if (req.method === 'GET' && m) {
        const out = api.getContent(decodeURIComponent(m[1]), {
          lang,
          sourceVersion: url.searchParams.get('sourceVersion') || undefined
        })
        return send(res, out.status, out)
      }

      // GET /docs/:id/history/:version?lang=
      m = p.match(/^\/docs\/([\w/-]+)\/history\/([\w.-]+)$/)
      if (req.method === 'GET' && m) {
        const out = api.getHistory(decodeURIComponent(m[1]), decodeURIComponent(m[2]), lang)
        return send(res, out.status, out)
      }

      // GET /docs/:id
      const md = p.match(/^\/docs\/([\w/-]+)$/)
      if (req.method === 'GET' && md) {
        const doc = api.getDoc(decodeURIComponent(md[1]))
        if (!doc) return send(res, 404, { error: { code: 'doc-not-found' } })
        return send(res, 200, {
          doc: api.index().find((d) => d.id === doc.id),
          languages: api.listLanguages(doc)
        })
      }

      // POST /reviews  (If-Match: <revision>)
      if (req.method === 'POST' && p === '/reviews') {
        const body = await readJson(req)
        const doc = api.getDoc(body.docId)
        if (!doc) return send(res, 404, { error: { code: 'doc-not-found' } })
        const version = api.resolveVersion(doc, body.sourceDocVersion)
        const seg = version?.segments.find((s) => s.id === body.sourceId)
        if (!seg) return send(res, 400, { error: { code: 'unknown-source-segment' } })
        const result = submitReview(initialStore, {
          docId: body.docId,
          lang: body.lang || 'en',
          unitId: body.unitId,
          expectedRevision: req.headers['if-match'] ?? body.expectedRevision ?? null,
          translationHash: body.translationHash || hashSegment(body.tokens || []),
          sourceHash: body.sourceHash,
          sourceDocVersion: body.sourceDocVersion,
          codeVersion: body.codeVersion,
          reviewer: body.reviewer || 'anonymous'
        })
        return send(res, result.status, result.error ? result : { review: result.review })
      }

      // POST /proposals/:id/decision
      const mprop = p.match(/^\/proposals\/([\w-]+)\/decision$/)
      if (req.method === 'POST' && mprop) {
        const body = await readJson(req)
        const result = decideProposal(
          initialStore, decodeURIComponent(mprop[1]),
          body.decision, body.reviewer || 'anonymous'
        )
        return send(res, result.status, result.error ? result : { proposal: result.proposal })
      }

      // GET /search?q=&lang=
      if (req.method === 'GET' && p === '/search') {
        const q = url.searchParams.get('q') || ''
        const hits = search(searchIndex, q, { lang: url.searchParams.get('lang') || undefined })
        return send(res, 200, { query: q, hits: hits.map((h) => ({ ...h, route: hitRoute(h) })) })
      }

      return send(res, 404, { error: { code: 'route-not-found', path: p } })
    } catch (err) {
      return send(res, 400, { error: { code: err.message } })
    }
  }

  return http.createServer(handler)
}

const isMain = process.argv[1] && process.argv[1].endsWith('server/index.js')
if (isMain) {
  const port = Number(process.env.PORT || 5174)
  createI18nServer().listen(port, () => {
    console.log(`i18n content API listening on http://localhost:${port}/api/i18n`)
  })
}
