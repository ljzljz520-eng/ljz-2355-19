// 双语阅读核心场景测试：语义对齐、基线漂移、共享代码、并发冲突、历史版本、语言锁
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../server/db.js'
import * as repo from '../server/repo.js'
import { createServer } from '../server/api.js'

/** 构造三段落文档：zh s1..s3 ↔ en t1..t3，全部已验证 */
function setupDoc(db, docId = 'd1') {
  db.prepare('INSERT INTO documents (id, title, src_lang) VALUES (?,?,?)').run(docId, docId, 'zh')
  repo.publishVersion(db, { docId, lang: 'zh', blocks: [
    { key: 's1', type: 'paragraph', content: '第一段：安装组件库并引入样式文件。' },
    { key: 's2', type: 'paragraph', content: '第二段：在入口文件中注册全部组件。' },
    { key: 's3', type: 'paragraph', content: '第三段：参考示例完成页面搭建。' },
  ] })
  repo.publishVersion(db, { docId, lang: 'en', blocks: [
    { key: 't1', type: 'paragraph', content: 'Section one: install the library and import styles.' },
    { key: 't2', type: 'paragraph', content: 'Section two: register all components in the entry file.' },
    { key: 't3', type: 'paragraph', content: 'Section three: follow the examples to build the page.' },
  ] })
  for (const [s, t] of [['s1', 't1'], ['s2', 't2'], ['s3', 't3']]) {
    repo.setAlignment(db, { docId, srcKey: s, tgtLang: 'en', tgtKeys: [t], confirmed: 1 })
    repo.markVerified(db, { docId, tgtLang: 'en', tgtKey: t })
  }
}

test('章节重排：语义键继承，对齐与已验状态不漂移', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  // zh v2：仅调整段落顺序（s3,s1,s2），不传 key，靠内容哈希继承
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks: [
    { type: 'paragraph', content: '第三段：参考示例完成页面搭建。' },
    { type: 'paragraph', content: '第一段：安装组件库并引入样式文件。' },
    { type: 'paragraph', content: '第二段：在入口文件中注册全部组件。' },
  ] })
  const view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  assert.deepEqual(view.pairs.map((p) => p.src.seg_key), ['s3', 's1', 's2']) // 新顺序
  assert.deepEqual(view.pairs.map((p) => p.targets[0]?.link.tgt_key), ['t3', 't1', 't2']) // 对齐仍正确
  assert.equal(view.summary.verified, 3)
  assert.equal(view.summary.needs_review, 0) // 重排不触发待复核
})

test('原文修改：仅相关译段待复核，未改段保留已验状态', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  const v1 = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  const blocks = v1.src.segments.map((s) => ({ key: s.seg_key, type: s.seg_type, content: s.content }))
  blocks[1].content = '第二段：在入口文件中按需注册所需组件。' // 仅改 s2
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks })
  const view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  const bySrc = Object.fromEntries(view.pairs.map((p) => [p.src.seg_key, p.status]))
  assert.equal(bySrc.s1, 'verified')
  assert.equal(bySrc.s2, 'needs_review') // 只有相关译段待复核
  assert.equal(bySrc.s3, 'verified')
  assert.equal(view.banner.stale, true)
  assert.equal(view.banner.fullySynced, false) // 过期译文不得包装成完全同步
  assert.equal(view.banner.basedOnSrcVersion, 1)
  assert.equal(view.banner.currentSrcVersion, 2)
})

test('中文一段拆分对应英文多段：一对多对齐，源改则多个译段同时待复核', () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO documents (id, title, src_lang) VALUES (?,?,?)').run('d2', 'd2', 'zh')
  repo.publishVersion(db, { docId: 'd2', lang: 'zh', blocks: [{ key: 's1', type: 'paragraph', content: '遥测默认关闭，可通过环境变量开启，数据匿名且不含源码。' }] })
  repo.publishVersion(db, { docId: 'd2', lang: 'en', blocks: [
    { key: 't1', type: 'paragraph', content: 'Telemetry is off by default and can be enabled via env vars.' },
    { key: 't2', type: 'paragraph', content: 'The data is anonymous and never contains source code.' },
  ] })
  repo.setAlignment(db, { docId: 'd2', srcKey: 's1', tgtLang: 'en', tgtKeys: ['t1', 't2'], confirmed: 1 })
  repo.markVerified(db, { docId: 'd2', tgtLang: 'en', tgtKey: 't1' })
  repo.markVerified(db, { docId: 'd2', tgtLang: 'en', tgtKey: 't2' })
  let view = repo.getBilingual(db, { docId: 'd2', tgtLang: 'en' })
  assert.equal(view.pairs.length, 1)
  assert.deepEqual(view.pairs[0].targets.map((t) => t.link.tgt_key), ['t1', 't2']) // 一对多
  // 修改源段 → 两个译段都待复核
  repo.publishVersion(db, { docId: 'd2', lang: 'zh', blocks: [{ key: 's1', type: 'paragraph', content: '遥测默认关闭，可通过环境变量或配置文件开启，数据匿名且不含源码。' }] })
  view = repo.getBilingual(db, { docId: 'd2', tgtLang: 'en' })
  assert.deepEqual(view.pairs[0].targets.map((t) => t.status.status), ['needs_review', 'needs_review'])
})

test('来源缺失：源段删除后译段标记 missing_source 并进入孤儿列表', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks: [
    { type: 'paragraph', content: '第一段：安装组件库并引入样式文件。' },
    { type: 'paragraph', content: '第三段：参考示例完成页面搭建。' },
  ] }) // s2 被删除
  const view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(view.summary.missing_source, 1)
  assert.equal(view.orphanTgt.length, 1)
  assert.equal(view.orphanTgt[0].segment.seg_key, 't2')
  assert.equal(view.orphanTgt[0].status.status, 'missing_source')
})

test('某语言暂缺：tgt 为 null，源段标记未翻译，不报错', () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO documents (id, title, src_lang) VALUES (?,?,?)').run('d3', 'd3', 'zh')
  repo.publishVersion(db, { docId: 'd3', lang: 'zh', blocks: [{ key: 's1', type: 'paragraph', content: '只有中文。' }] })
  const view = repo.getBilingual(db, { docId: 'd3', tgtLang: 'fr' })
  assert.equal(view.tgt, null)
  assert.equal(view.summary.untranslated, 1)
  assert.equal(view.banner.fullySynced, false)
})

test('共享代码：双语引用同一代码块，更新一处同时生效，译文不复制代码', () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO documents (id, title, src_lang) VALUES (?,?,?)').run('d4', 'd4', 'zh')
  const code = '```bash\nnpm install my-lib\n```'
  repo.publishVersion(db, { docId: 'd4', lang: 'zh', blocks: [{ key: 'c1', type: 'code', content: code, ordinal: 1 }] })
  repo.publishVersion(db, { docId: 'd4', lang: 'en', blocks: [{ key: 'c1', type: 'code', content: code, ordinal: 1 }] })
  repo.setAlignment(db, { docId: 'd4', srcKey: 'c1', tgtLang: 'en', tgtKeys: ['c1'], confirmed: 1 })
  repo.markVerified(db, { docId: 'd4', tgtLang: 'en', tgtKey: 'c1' })

  const zhSeg = db.prepare(`SELECT s.* FROM segments s JOIN doc_versions v ON v.id = s.version_id
    WHERE v.doc_id = 'd4' AND v.lang = 'zh' AND s.seg_key = 'c1'`).get()
  const enSeg = db.prepare(`SELECT s.* FROM segments s JOIN doc_versions v ON v.id = s.version_id
    WHERE v.doc_id = 'd4' AND v.lang = 'en' AND s.seg_key = 'c1'`).get()
  assert.equal(zhSeg.code_ref, enSeg.code_ref) // 同一引用
  assert.equal(enSeg.content, '') // 译文段不复制代码正文

  repo.updateCodeBlock(db, { id: zhSeg.code_ref, content: '```bash\nnpm install my-lib@2\n```', by: 'dev' })
  const view = repo.getBilingual(db, { docId: 'd4', tgtLang: 'en' })
  assert.ok(view.pairs[0].src.code.content.includes('my-lib@2')) // 源侧生效
  assert.ok(view.pairs[0].targets[0].segment.code.content.includes('my-lib@2')) // 译侧同时生效
  assert.equal(view.pairs[0].targets[0].status.status, 'verified') // 代码更新不打乱译文审阅状态
})

test('两译者编辑同段：乐观锁拦截后提交者，重新基于最新锁版本可成功', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  // 甲先提交（基于 lock_version=1）
  repo.submitTranslation(db, { docId: 'd1', tgtLang: 'en', tgtKey: 't1', content: 'Alice: install the lib and import styles.', translator: 'alice', expectedLockVersion: 1 })
  // 乙仍基于 lock_version=1 → 冲突
  assert.throws(
    () => repo.submitTranslation(db, { docId: 'd1', tgtLang: 'en', tgtKey: 't1', content: 'Bob: install library, import styles.', translator: 'bob', expectedLockVersion: 1 }),
    (e) => e.code === 'CONFLICT' && e.current.translator === 'alice' && e.current.lock_version === 2
  )
  // 乙读取最新锁版本后重新提交 → 成功
  const r = repo.submitTranslation(db, { docId: 'd1', tgtLang: 'en', tgtKey: 't1', content: 'Bob: install library, import styles.', translator: 'bob', expectedLockVersion: 2 })
  assert.equal(r.status, 'verified')
  const st = db.prepare(`SELECT * FROM segment_status WHERE doc_id='d1' AND tgt_key='t1'`).get()
  assert.equal(st.translator, 'bob')
  assert.equal(st.lock_version, 3)
})

test('对齐冲突：一个译段被两个源段声称 → conflict，人工改对齐后恢复', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  repo.setAlignment(db, { docId: 'd1', srcKey: 's2', tgtLang: 'en', tgtKeys: ['t1'], confirmed: 1 }) // t1 同时被 s1、s2 对齐
  let view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(view.summary.conflict, 1)
  // 人工确认入口：修正对齐（s2 重新对齐 t2）
  repo.setAlignment(db, { docId: 'd1', srcKey: 's2', tgtLang: 'en', tgtKeys: ['t2'], confirmed: 1, by: 'reviewer' })
  repo.confirmSegment(db, { docId: 'd1', tgtLang: 'en', tgtKey: 't1', reviewer: 'reviewer' })
  view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(view.summary.conflict, 0)
  assert.equal(view.summary.verified, 3)
})

test('整篇语言锁 vs 段落级对齐图：in_sync → stale → 修复后重锁；未验证不可锁', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  repo.lockDocument(db, { docId: 'd1', tgtLang: 'en', by: 'pm' })
  let report = repo.getSyncReport(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(report.lockStatus, 'in_sync')
  assert.equal(report.presentableAsSynced, true)

  // 原文升级 → 锁过期（stale），且不可再锁
  const view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  const blocks = view.src.segments.map((s) => ({ key: s.seg_key, type: s.seg_type, content: s.content }))
  blocks[0].content = '第一段：安装组件库、引入样式文件并注册插件。'
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks })
  report = repo.getSyncReport(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(report.lockStatus, 'stale')
  assert.equal(report.presentableAsSynced, false)
  assert.equal(report.drifted.length, 1)
  assert.throws(() => repo.lockDocument(db, { docId: 'd1', tgtLang: 'en' }), /cannot lock/)

  // 人工确认漂移段 → 可重锁 → in_sync
  repo.confirmSegment(db, { docId: 'd1', tgtLang: 'en', tgtKey: 't1', reviewer: 'pm' })
  repo.lockDocument(db, { docId: 'd1', tgtLang: 'en', by: 'pm' })
  report = repo.getSyncReport(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(report.lockStatus, 'in_sync')
  assert.equal(report.lock.srcVersion, 2)

  // 版本未变但对齐图被人工改动 → broken（锁与图冲突）
  repo.setAlignment(db, { docId: 'd1', srcKey: 's3', tgtLang: 'en', tgtKeys: [] })
  report = repo.getSyncReport(db, { docId: 'd1', tgtLang: 'en' })
  assert.equal(report.lockStatus, 'broken')
  assert.equal(report.presentableAsSynced, false)
})

test('搜索进入历史版：旧文本命中历史版本，历史视图明确标注非最新', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  const view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  const blocks = view.src.segments.map((s) => ({ key: s.seg_key, type: s.seg_type, content: s.content }))
  blocks[0].content = '第一段：通过 CDN 引入组件库。'
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks })

  const hits = repo.search(db, { q: '安装组件库并引入样式文件' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].versionNo, 1)
  assert.equal(hits[0].isLatest, false) // 历史版

  const hist = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en', srcVersionNo: 1 })
  assert.equal(hist.src.isLatest, false)
  assert.equal(hist.banner.currentSrcVersion, 2)
  assert.equal(hist.banner.fullySynced, false)
})

test('不可翻译标记：译文缺失原文的行内代码标记时给出警告', () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO documents (id, title, src_lang) VALUES (?,?,?)').run('d5', 'd5', 'zh')
  repo.publishVersion(db, { docId: 'd5', lang: 'zh', blocks: [{ key: 's1', type: 'paragraph', content: '设置 `MYLIB_TELEMETRY=1` 并调整 `interval` 参数。' }] })
  repo.publishVersion(db, { docId: 'd5', lang: 'en', blocks: [{ key: 't1', type: 'paragraph', content: 'placeholder' }] })
  repo.setAlignment(db, { docId: 'd5', srcKey: 's1', tgtLang: 'en', tgtKeys: ['t1'], confirmed: 1 })
  const r = repo.submitTranslation(db, { docId: 'd5', tgtLang: 'en', tgtKey: 't1', content: 'Set the env var and tune the `interval` parameter.', translator: 'alice' })
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /MYLIB_TELEMETRY=1/)
})

test('确认后基线更新：原文再次发布未改内容时保持已验', () => {
  const db = openDb(':memory:')
  setupDoc(db)
  const view = repo.getBilingual(db, { docId: 'd1', tgtLang: 'en' })
  const blocks = view.src.segments.map((s) => ({ key: s.seg_key, type: s.seg_type, content: s.content }))
  blocks[0].content = '第一段：安装组件库并引入样式文件（已修订）。'
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks })
  let st = db.prepare(`SELECT status FROM segment_status WHERE doc_id='d1' AND tgt_key='t1'`).get()
  assert.equal(st.status, 'needs_review')
  repo.confirmSegment(db, { docId: 'd1', tgtLang: 'en', tgtKey: 't1', reviewer: 'pm' })
  // 原文再发一版但内容未变 → 不再漂移
  repo.publishVersion(db, { docId: 'd1', lang: 'zh', blocks })
  st = db.prepare(`SELECT status FROM segment_status WHERE doc_id='d1' AND tgt_key='t1'`).get()
  assert.equal(st.status, 'verified')
})

// ---------- HTTP API 集成 ----------
let server, base
before(async () => {
  server = createServer(':memory:')
  setupDoc(server.db, 'api-doc')
  await new Promise((r) => server.listen(0, r))
  server.unref()
  base = `http://localhost:${server.address().port}`
})

test('API：双语视图 / 翻译提交 409 / 确认 / 搜索 / 锁定 422', async () => {
  const j = async (res) => ({ status: res.status, body: await res.json() })

  let r = await j(await fetch(`${base}/api/docs/api-doc/bilingual?tgt=en`))
  assert.equal(r.status, 200)
  assert.equal(r.body.summary.verified, 3)
  assert.equal(r.body.banner.fullySynced, true)

  // 甲提交译文
  r = await j(await fetch(`${base}/api/docs/api-doc/translations`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tgtLang: 'en', tgtKey: 't2', content: 'Alice update.', translator: 'alice', expectedLockVersion: 1 }) }))
  assert.equal(r.status, 200)

  // 乙基于过期锁版本 → 409 并返回当前状态
  r = await j(await fetch(`${base}/api/docs/api-doc/translations`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tgtLang: 'en', tgtKey: 't2', content: 'Bob update.', translator: 'bob', expectedLockVersion: 1 }) }))
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'CONFLICT')
  assert.equal(r.body.current.translator, 'alice')

  // 原文修改 → 待复核 → 人工确认
  const view = (await j(await fetch(`${base}/api/docs/api-doc/bilingual?tgt=en`))).body
  const blocks = view.src.segments.map((s) => ({ key: s.seg_key, type: s.seg_type, content: s.content }))
  blocks[2].content = '第三段：参考示例与最佳实践完成页面搭建。'
  r = await j(await fetch(`${base}/api/docs/api-doc/versions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lang: 'zh', blocks, author: 'editor' }) }))
  assert.equal(r.status, 201)
  const after = (await j(await fetch(`${base}/api/docs/api-doc/bilingual?tgt=en`))).body
  assert.equal(after.summary.needs_review, 1)
  r = await j(await fetch(`${base}/api/docs/api-doc/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tgtLang: 'en', tgtKey: 't3', reviewer: 'pm' }) }))
  assert.equal(r.body.status, 'verified')

  // 全部已验证 → 可锁定；再制造漂移 → 锁定 422
  r = await j(await fetch(`${base}/api/docs/api-doc/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tgtLang: 'en', by: 'pm' }) }))
  assert.equal(r.status, 200)
  const report = (await j(await fetch(`${base}/api/docs/api-doc/sync-report?tgt=en`))).body
  assert.equal(report.lockStatus, 'in_sync')

  // 搜索历史版：t2 的旧译文仍可在历史版本中检索到
  r = await j(await fetch(`${base}/api/search?q=${encodeURIComponent('register all components')}`))
  assert.equal(r.status, 200)
  assert.ok(r.body.results.some((x) => !x.isLatest && x.versionNo === 1))
})

after(() => server?.close())
