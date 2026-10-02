import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchIndex, search, hitRoute } from '../core/search.js'
import { createContentApi } from '../core/content.js'
import { createStore } from '../store/createStore.js'
import { seed } from '../fixtures/seed.js'

test('search hit remembers its source version and routes to historical view', () => {
  const store = createStore(seed)
  const idx = buildSearchIndex(store)
  // wording only present in 1.0.0 source
  const hits = search(idx, 'npm 安装')
  assert.ok(hits.length > 0)
  const old = hits.find((h) => h.docVersion === '1.0.0' && h.lang === 'zh')
  assert.ok(old, '1.0.0 wording remains discoverable')
  const route = hitRoute(old)
  assert.equal(route.sourceVersion, '1.0.0')
  assert.equal(route.historical, true)
})

test('search scoped by language and code bodies are searchable', () => {
  const idx = buildSearchIndex(createStore(seed))
  const en = search(idx, 'npm install', { lang: 'en' })
  assert.ok(en.every((h) => h.lang === 'en'))
  const codeHits = search(idx, 'BaseButton')
  assert.ok(codeHits.some((h) => h.segmentId === 'c-demo-button'))
})

test('historical content endpoint is marked archive with latest version', () => {
  const api = createContentApi(createStore(seed))
  const h = api.getHistory('components/button', '1.0.0', 'en')
  assert.equal(h.isHistorical, true)
  assert.equal(h.archive.requestedVersion, '1.0.0')
  assert.equal(h.archive.latestVersion, '1.2.0')
  assert.match(h.archive.note, /frozen archive/i)
})
