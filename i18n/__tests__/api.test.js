import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createI18nServer } from '../server/index.js'

const listen = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)))
const call = async (port, path, opts = {}) => {
  const res = await fetch(`http://localhost:${port}/api/i18n${path}`, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  return { status: res.status, json: await res.json() }
}

test('HTTP: content, missing language, history archive', async () => {
  const srv = createI18nServer()
  const port = await listen(srv)
  try {
    const idx = await call(port, '/docs')
    assert.equal(idx.status, 200)
    assert.equal(idx.json.docs.length, 3)

    const c = await call(port, '/docs/components/button/content?lang=en&sourceVersion=1.1.0')
    assert.equal(c.status, 200)
    assert.ok(c.json.graph.edges.length > 0)
    assert.ok(c.json.conflicts.some((x) => x.code === 'source-missing'))

    const missing = await call(port, '/docs/components/tag/content?lang=en')
    assert.equal(missing.status, 200)
    assert.equal(missing.json.targetAvailable, false)

    const hist = await call(port, '/docs/components/button/history/1.0.0?lang=en')
    assert.equal(hist.json.archive.latestVersion, '1.2.0')

    const search = await call(port, '/search?q=npm%20%E5%AE%89%E8%A3%85&lang=zh')
    assert.ok(search.json.hits.some((h) => h.docVersion === '1.0.0'))
  } finally {
    srv.close()
  }
})

test('HTTP: review submit with If-Match produces 409 on stale revision', async () => {
  const srv = createI18nServer()
  const port = await listen(srv)
  try {
    const body = {
      docId: 'guide/installation', lang: 'en', unitId: 'p-install',
      sourceId: 'p-install', sourceDocVersion: '1.1.0',
      tokens: [{ kind: 'text', text: 'changed by late translator' }],
      sourceHash: 'doesntmatter', reviewer: 'reviewer-a'
    }
    const ok = await call(port, '/reviews', {
      method: 'POST', headers: { 'If-Match': '2', 'content-type': 'application/json' }, body
    })
    assert.equal(ok.status, 200)
    const clash = await call(port, '/reviews', {
      method: 'POST', headers: { 'If-Match': '1', 'content-type': 'application/json' }, body
    })
    assert.equal(clash.status, 409)
    assert.equal(clash.json.error.code, 'revision-conflict')
  } finally {
    srv.close()
  }
})

test('HTTP: proposal decision endpoint', async () => {
  const srv = createI18nServer()
  const port = await listen(srv)
  try {
    const r = await call(port, '/proposals/prop-2/decision', {
      method: 'POST', body: { decision: 'rejected', reviewer: 'lead' }
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.proposal.status, 'rejected')
  } finally {
    srv.close()
  }
})
