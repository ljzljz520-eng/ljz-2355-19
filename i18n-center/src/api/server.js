import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, clearTables } from '../db/index.js'
import { resolveReader } from '../align/resolve.js'
import { search } from '../content/search.js'
import { listVersions, publishVersion, bootstrapUnits } from '../content/version.js'
import { autoAlign, setManualAlignment, dismissEdge } from '../align/align.js'
import {
  saveUnit, submitUnit, verifyUnit, resolveEditConflict,
  setLanguageLock, clearLanguageLock, listReviewQueue, actOnReview,
  unitHistory, updateCodeReference, getUnit
} from '../content/units.js'
import { seedInto } from '../../scripts/seed.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.join(__dirname, '../web')
const dbPath = process.env.I18N_DB
const db = openDb(dbPath)
const now = () => Date.now()

// 空库自动播种演示数据（可用 /admin/reseed 重置）
if (db.prepare('SELECT COUNT(*) c FROM documents').get().c === 0) {
  seedInto(db)
}

function send(res, code, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  res.writeHead(code, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' })
  res.end(body)
}
const readBody = (req) => new Promise((res2, rej) => {
  let buf = ''
  req.on('data', (c) => { buf += c; if (buf.length > 1e6) rej(new Error('body too large')) })
  req.on('end', () => { try { res2(buf ? JSON.parse(buf) : {}) } catch { rej(Object.assign(new Error('bad json'), { status: 400 })) } })
})
const num = (v) => (v == null || v === '' ? undefined : Number(v))

async function handleApi(req, res, url) {
  const p = url.pathname
  const q = url.searchParams

  // ---- documents ----
  if (p === '/api/documents' && req.method === 'GET') {
    const docs = db.prepare(`SELECT d.doc_id, d.slug, d.title, d.source_lang,
        (SELECT MAX(version_no) FROM document_versions v WHERE v.doc_id=d.doc_id AND v.lang=d.source_lang) src_latest
      FROM documents d ORDER BY d.doc_id`).all()
    for (const d of docs) d.versions = listVersions(db, d.doc_id)
    return send(res, 200, { documents: docs })
  }

  // ---- reader ----
  if (p === '/api/reader' && req.method === 'GET') {
    const doc = q.get('doc')
    const tgt = q.get('tgt') || 'en'
    const mode = q.get('mode') === 'lock' ? 'lock' : 'graph'
    const r = resolveReader(db, { doc, tgtLang: tgt, mode, srcVersion: num(q.get('srcV')), tgtVersion: num(q.get('tgtV')) })
    return send(res, 200, r)
  }

  // ---- search ----
  if (p === '/api/search' && req.method === 'GET') {
    return send(res, 200, search(db, { q: q.get('q'), lang: q.get('lang') || undefined, doc: q.get('doc') || undefined }))
  }

  // ---- unit get/history ----
  if (p === '/api/unit' && req.method === 'GET') {
    const u = getUnit(db, q.get('doc'), q.get('node'), q.get('tgt') || 'en')
    const hist = unitHistory(db, q.get('doc'), q.get('node'), q.get('tgt') || 'en')
    return send(res, 200, { unit: u, history: hist })
  }

  // ---- review queue ----
  if (p === '/api/review' && req.method === 'GET') {
    const queue = listReviewQueue(db, q.get('doc')).map((it) => ({
      id: it.id, doc_id: it.doc_id, kind: it.kind, ref_key: it.ref_key, lang: it.lang,
      status: it.status, created_at: it.created_at, resolved_at: it.resolved_at, resolver: it.resolver,
      detail: JSON.parse(it.detail_json || '{}')
    }))
    return send(res, 200, { queue })
  }

  // ---- mutations ----
  if (req.method === 'POST') {
    const body = await readBody(req)
    const actor = body.actor || 'anonymous'

    if (p === '/api/unit/save') return send(res, 200, saveUnit(db, { doc: body.doc, srcNodeKey: body.node, tgtLang: body.tgt || 'en', body: body.body, actor, baseRevision: body.baseRevision }))
    if (p === '/api/unit/submit') return send(res, 200, submitUnit(db, { doc: body.doc, srcNodeKey: body.node, tgtLang: body.tgt || 'en', actor }))
    if (p === '/api/unit/verify') return send(res, 200, verifyUnit(db, { doc: body.doc, srcNodeKey: body.node, tgtLang: body.tgt || 'en', reviewer: actor }))
    if (p === '/api/conflict/resolve') return send(res, 200, resolveEditConflict(db, { doc: body.doc, conflictId: Number(body.conflictId), mergedBody: body.body, actor }))

    if (p === '/api/align/auto') return send(res, 200, autoAlign(db, body.doc, body.srcLang || 'zh', body.tgtLang || 'en', { srcVersion: body.srcVersion, tgtVersion: body.tgtVersion }))
    if (p === '/api/align/manual') return send(res, 200, setManualAlignment(db, body.doc, body.srcLang || 'zh', body.tgtLang || 'en', body.srcKeys, body.tgtKeys, actor))
    if (p === '/api/align/dismiss') return send(res, 200, dismissEdge(db, body.doc, body.srcLang, body.node, body.tgtLang, body.tgtNode))

    if (p === '/api/lock/set') return send(res, 200, setLanguageLock(db, { doc: body.doc, tgtLang: body.tgt || 'en', actor, srcVersion: body.srcVersion }))
    if (p === '/api/lock/clear') return send(res, 200, clearLanguageLock(db, { doc: body.doc, tgtLang: body.tgt || 'en' }))

    if (p === '/api/review/act') return send(res, 200, actOnReview(db, { doc: body.doc, reviewId: Number(body.reviewId), action: body.action, actor, detail: body.detail || {} }))
    if (p === '/api/code/refresh') return send(res, 200, updateCodeReference(db, { doc: body.doc, srcNodeKey: body.node, tgtLang: body.tgt || 'en' }))

    if (p === '/admin/reseed') {
      clearTables(db)
      const r = seedInto(db)
      return send(res, 200, { ok: true, conflict: r.conflict })
    }
    if (p === '/admin/publish') {
      publishVersion(db, { docId: body.doc, lang: body.lang, versionNo: body.versionNo, markdown: body.markdown, editor: actor, note: body.note || '' })
      bootstrapUnits(db, body.doc, body.targetLangs || [])
      return send(res, 200, { ok: true })
    }
  }

  send(res, 404, { error: 'not found', path: p })
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }
function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname
  const file = path.normalize(path.join(webDir, rel))
  if (!file.startsWith(webDir)) return send(res, 403, 'forbidden')
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found')
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/')) return await handleApi(req, res, url)
    return serveStatic(req, res, url)
  } catch (e) {
    const code = e.status || 500
    send(res, code, { error: e.message, ...(e.conflictId ? { conflictId: e.conflictId, serverRevision: e.serverRevision, serverBody: e.serverBody } : {}) })
  }
})

const PORT = process.env.PORT || 5180
server.listen(PORT, () => console.log(`i18n-center on http://localhost:${PORT} (db: ${dbPath || 'default data/i18n.db'})`))
