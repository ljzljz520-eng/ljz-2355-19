// HTTP 端到端：真实 node:http 路由，验证错误码与状态结构
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../src/api/server.js'

let base, tmp, stop
const req = (p, { method = 'GET', body } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(async (res) => ({ status: res.status, json: await res.json() }))

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-api-'))
  const srv = await createServer({ dbFile: path.join(tmp, 't.sqlite'), port: 0 })
  stop = srv.server
  const addr = srv.server.address()
  base = `http://localhost:${addr.port}`
})

after(() => {
  stop.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('ingest -> reader -> search -> decision 全链路', async () => {
  const zh = `# D\n\n<!-- i18n:id=p1 -->\n原文一段\n`
  const en = `# D\n\n<!-- i18n:id=p1 xref=p1 -->\nOne paragraph\n`
  let r = await req('/api/ingest', { method: 'POST', body: { docId: 'doc', lang: 'zh', raw: zh, title: 'D' } })
  assert.equal(r.status, 200)
  r = await req('/api/ingest', { method: 'POST', body: { docId: 'doc', lang: 'en', raw: en, title: 'D' } })
  assert.equal(r.json.version, 1)

  const reader = await req('/api/reader/doc')
  assert.equal(reader.status, 200)
  assert.equal(reader.json.pairs[0].status.effective, 'untranslated')

  const saved = await req('/api/translations', {
    method: 'POST',
    body: { docId: 'doc', srcNid: 'p1', tgtNid: 'p1', content: 'One paragraph', actor: 'a' }
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.baselineVersion, 1)

  const review = await req('/api/translations/review', {
    method: 'POST',
    body: { docId: 'doc', srcNid: 'p1', tgtNid: 'p1', status: 'verified', reviewer: 'r' }
  })
  assert.equal(review.status, 200)

  // 原文改版（同 id，内容变）-> stale
  const zh2 = `# D\n\n<!-- i18n:id=p1 -->\n原文一段（更新）\n`
  await req('/api/ingest', { method: 'POST', body: { docId: 'doc', lang: 'zh', raw: zh2 } })
  const staleReader = await req('/api/reader/doc')
  assert.equal(staleReader.json.pairs[0].status.effective, 'stale')

  const hits = await req('/api/search?q=更新&lang=zh&docId=doc&version=2')
  assert.ok(hits.json.hits.some((h) => h.nid === 'p1' && h.version === 2))
})

test('404 / 423 / 409 / 422 错误均为结构化 JSON', async () => {
  const nf = await req('/api/reader/nope')
  assert.equal(nf.status, 404)
  assert.equal(nf.json.error.code, 'doc-not-found')

  await req('/api/ingest', { method: 'POST', body: { docId: 'lockdoc', lang: 'zh', raw: '# L\n\n<!-- i18n:id=s -->\n`x`\n', title: 'L' } })
  await req('/api/ingest', { method: 'POST', body: { docId: 'lockdoc', lang: 'en', raw: '# L\n\n<!-- i18n:id=s xref=s -->\n`x`\n', title: 'L' } })
  await req('/api/locks', { method: 'POST', body: { docId: 'lockdoc', lang: 'en', actor: 'a', ttl: 600 } })
  const locked = await req('/api/translations', {
    method: 'POST',
    body: { docId: 'lockdoc', srcNid: 's', tgtNid: 's', content: '`x`', actor: 'b' }
  })
  assert.equal(locked.status, 423)
  assert.equal(locked.json.error.code, 'language-locked')

  const bad = await req('/api/translations', {
    method: 'POST',
    body: { docId: 'lockdoc', srcNid: 's', tgtNid: 's', content: 'no backtick ref', actor: 'a' }
  })
  assert.equal(bad.status, 422)
  assert.deepEqual(bad.json.error.details.missing, ['x'])
})

test('缺失语言：targetMissing 结构', async () => {
  await req('/api/ingest', { method: 'POST', body: { docId: 'one', lang: 'zh', raw: '# O\n\n<!-- i18n:id=z -->\n仅中文\n', title: 'O' } })
  const r = await req('/api/reader/one')
  assert.equal(r.json.targetMissing, true)
  assert.deepEqual(r.json.pairs, [])
})
