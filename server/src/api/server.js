// 内容 API（零依赖 node:http）。统一 JSON 错误结构，不抛 HTML。
import http from 'node:http'
import { URL } from 'node:url'
import { openDb } from '../db.js'
import {
  HttpError,
  listDocs,
  ingestVersion,
  rebuildEdges,
  getReader,
  saveTranslation,
  acquireLock,
  releaseLock,
  acquireSegmentLock,
  decideEdge,
  manualPair,
  reviewTranslation,
  search,
  versions
} from '../content.js'

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 2_000_000) reject(new HttpError(413, 'too-large', '请求体过大'))
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new HttpError(400, 'bad-json', '请求体不是合法 JSON'))
      }
    })
  })

export async function createServer({ dbFile, port = 5174 } = {}) {
  const db = await openDb(dbFile)

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname.replace(/\/+$/, '') || '/'
    const q = Object.fromEntries(url.searchParams)
    try {
      // --- 文档 ---
      if (req.method === 'GET' && p === '/api/docs') return json(res, 200, { docs: listDocs(db) })

      if (req.method === 'GET' && /^\/api\/docs\/[^/]+\/versions$/.test(p)) {
        const docId = p.split('/')[3]
        return json(res, 200, { docId, versions: versions(db, docId) })
      }

      // --- 阅读器（核心：语言版本 + 对应关系 + 基线/审阅状态） ---
      if (req.method === 'GET' && /^\/api\/reader\/[^/]+$/.test(p)) {
        const docId = p.split('/')[3]
        const body = await getReader(db, {
          docId,
          srcLang: q.srcLang || 'zh',
          tgtLang: q.tgtLang || 'en',
          srcVersion: q.srcVersion ? Number(q.srcVersion) : undefined,
          tgtVersion: q.tgtVersion ? Number(q.tgtVersion) : undefined
        })
        res.setHeader('cache-control', 'no-store')
        return json(res, 200, body)
      }

      // --- 摄入（CLI / seed 用） ---
      if (req.method === 'POST' && /^\/api\/ingest$/.test(p)) {
        const b = await readBody(req)
        const result = ingestVersion(db, b)
        return json(res, 200, result)
      }

      // --- 保存翻译 ---
      if (req.method === 'POST' && /^\/api\/translations$/.test(p)) {
        const b = await readBody(req)
        return json(res, 200, saveTranslation(db, b))
      }

      if (req.method === 'POST' && /^\/api\/translations\/review$/.test(p)) {
        const b = await readBody(req)
        return json(res, 200, reviewTranslation(db, b))
      }

      // --- 锁：整篇语言锁 / 段落锁 ---
      if (req.method === 'POST' && /^\/api\/locks$/.test(p)) {
        return json(res, 200, acquireLock(db, await readBody(req)))
      }
      if (req.method === 'DELETE' && /^\/api\/locks$/.test(p)) {
        return json(res, 200, releaseLock(db, await readBody(req)))
      }
      if (req.method === 'POST' && /^\/api\/locks\/segment$/.test(p)) {
        return json(res, 200, acquireSegmentLock(db, await readBody(req)))
      }

      // --- 人工确认入口 ---
      if (req.method === 'POST' && /^\/api\/edges\/\d+\/decision$/.test(p)) {
        const edgeId = Number(p.split('/')[3])
        const b = await readBody(req)
        return json(res, 200, decideEdge(db, { edgeId, ...b }))
      }
      if (req.method === 'POST' && /^\/api\/edges\/manual$/.test(p)) {
        return json(res, 200, manualPair(db, await readBody(req)))
      }
      if (req.method === 'POST' && /^\/api\/edges\/rebuild$/.test(p)) {
        const b = await readBody(req)
        return json(res, 200, rebuildEdges(db, b.docId, b.srcLang || 'zh', b.tgtLang || 'en'))
      }

      // --- 搜索（可带 version 进入历史版） ---
      if (req.method === 'GET' && p === '/api/search') {
        return json(res, 200, search(db, {
          q: q.q || '',
          lang: q.lang || 'zh',
          docId: q.docId || null,
          version: q.version ? Number(q.version) : null
        }))
      }

      if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true })

      return json(res, 404, { error: { code: 'not-found', message: `未知路由 ${req.method} ${p}` } })
    } catch (e) {
      if (e instanceof HttpError) {
        return json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } })
      }
      console.error(e)
      return json(res, 500, { error: { code: 'internal', message: e.message } })
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      console.error(e)
      if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: e.message } })
    })
  })

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, db, port }))
  })
}
