// 内容 API：语言版本、对齐关系、翻译基线、审阅状态、语言锁、跨版本搜索
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import * as repo from './repo.js'
import { segmentMarkdown } from './segmenter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, 'public')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }

export function createServer(dbFile = process.env.DOC_DB ?? ':memory:') {
  const db = openDb(dbFile)

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    try {
      // ---------- 静态前端 ----------
      if (req.method === 'GET' && (p === '/' || p.startsWith('/app.') || p.startsWith('/styles'))) {
        const file = path.join(PUBLIC, p === '/' ? 'index.html' : p)
        if (file.startsWith(PUBLIC) && fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'text/plain' })
          return res.end(fs.readFileSync(file))
        }
      }

      // ---------- 内容 API ----------
      if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true })

      if (req.method === 'GET' && p === '/api/docs') return json(res, 200, { docs: repo.listDocuments(db) })

      // 双语对齐视图（可指定历史版本对）
      let m = p.match(/^\/api\/docs\/(.+)\/bilingual$/)
      if (req.method === 'GET' && m) {
        const view = repo.getBilingual(db, {
          docId: decodeURIComponent(m[1]),
          tgtLang: url.searchParams.get('tgt') ?? 'en',
          srcVersionNo: num(url.searchParams.get('srcVersion')),
          tgtVersionNo: num(url.searchParams.get('tgtVersion')),
        })
        return json(res, 200, view)
      }

      m = p.match(/^\/api\/docs\/(.+)\/versions$/)
      if (req.method === 'GET' && m) {
        return json(res, 200, { versions: repo.listVersions(db, decodeURIComponent(m[1]), url.searchParams.get('lang') ?? 'zh') })
      }
      // 发布新版本（原文修改 / 章节重排 / 新增语言）。body: {lang, markdown?|blocks?, author, note}
      if (req.method === 'POST' && m) {
        const body = await readBody(req)
        const blocks = body.blocks ?? segmentMarkdown(body.markdown ?? '')
        const r = repo.publishVersion(db, { docId: decodeURIComponent(m[1]), lang: body.lang, blocks, author: body.author, note: body.note })
        return json(res, 201, r)
      }

      m = p.match(/^\/api\/docs\/(.+)\/translations$/)
      if (req.method === 'POST' && m) {
        const body = await readBody(req)
        const r = repo.submitTranslation(db, { docId: decodeURIComponent(m[1]), ...body })
        return json(res, 200, r)
      }

      m = p.match(/^\/api\/docs\/(.+)\/confirm$/)
      if (req.method === 'POST' && m) { // 人工确认入口
        const body = await readBody(req)
        return json(res, 200, repo.confirmSegment(db, { docId: decodeURIComponent(m[1]), ...body }))
      }

      m = p.match(/^\/api\/docs\/(.+)\/alignments$/)
      if (req.method === 'POST' && m) { // 人工调整对齐（含一对多）
        const body = await readBody(req)
        return json(res, 200, { conflicts: repo.setAlignment(db, { docId: decodeURIComponent(m[1]), ...body }) })
      }

      m = p.match(/^\/api\/docs\/(.+)\/lock$/)
      if (req.method === 'POST' && m) {
        const body = await readBody(req)
        return json(res, 200, { lock: repo.lockDocument(db, { docId: decodeURIComponent(m[1]), ...body }) })
      }
      if (req.method === 'DELETE' && m) {
        repo.unlockDocument(db, { docId: decodeURIComponent(m[1]) })
        return json(res, 200, { lock: null })
      }

      m = p.match(/^\/api\/docs\/(.+)\/sync-report$/)
      if (req.method === 'GET' && m) { // 整篇语言锁 vs 段落级对齐图
        return json(res, 200, repo.getSyncReport(db, { docId: decodeURIComponent(m[1]), tgtLang: url.searchParams.get('tgt') ?? 'en' }))
      }

      m = p.match(/^\/api\/code-blocks\/(.+)$/)
      if (req.method === 'PUT' && m) { // 共享代码更新：双语同时生效
        const body = await readBody(req)
        return json(res, 200, { codeBlock: repo.updateCodeBlock(db, { id: decodeURIComponent(m[1]), content: body.content, by: body.by }) })
      }

      if (req.method === 'GET' && p === '/api/search') { // 跨版本搜索（含历史版）
        return json(res, 200, { results: repo.search(db, { q: url.searchParams.get('q') ?? '', lang: url.searchParams.get('lang') || null }) })
      }

      return json(res, 404, { error: 'not found', path: p })
    } catch (e) {
      if (e.code === 'CONFLICT') return json(res, 409, { error: e.message, code: 'CONFLICT', current: e.current })
      if (e.blockers) return json(res, 422, { error: e.message, blockers: e.blockers })
      return json(res, 400, { error: e.message })
    }
  })
  server.db = db
  return server
}

const num = (v) => (v == null || v === '' ? null : Number(v))

if (process.argv[1] && process.argv[1].endsWith('api.js')) {
  const port = Number(process.env.PORT ?? 5174)
  // CLI 默认使用种子库 server/docs.db（npm run docs:seed 产物）；
  // 测试仍以 createServer(':memory:') 显式传入内存库
  const defaultDbFile = path.join(__dirname, 'docs.db')
  const dbFile = process.env.DOC_DB ?? (fs.existsSync(defaultDbFile) ? defaultDbFile : ':memory:')
  const server = createServer(dbFile)
  server.listen(port, () => console.log(`[bilingual-docs] API + reader at http://localhost:${port} (db: ${server.db.name})`))
}
