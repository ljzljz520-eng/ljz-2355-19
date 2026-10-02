import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createHash } from 'node:crypto'
import {
  ingestVersion,
  getReader,
  saveTranslation,
  reviewTranslation,
  acquireLock,
  acquireSegmentLock,
  decideEdge,
  manualPair,
  search,
  versions,
  rebuildEdges,
  releaseLock,
  HttpError
} from '../src/content.js'

let db, tmpDir

const ZH_V1 = `# T\n\n<!-- i18n:id=intro -->\n介绍\n\n<!-- i18n:id=install -->\n用 NPM 安装\n`
const EN_V1 = `# T\n\n<!-- i18n:id=en-intro xref=intro -->\nIntro\n\n<!-- i18n:id=en-install xref=install -->\nInstall with NPM\n`
// 原文 v2：intro 不变，install 变化
const ZH_V2 = `# T\n\n<!-- i18n:id=intro -->\n介绍\n\n<!-- i18n:id=install -->\n推荐用包管理器安装，也可用 CDN\n`
// 原文 v3：章节重排（install 在前），nid 不变
const ZH_V3 = `# T\n\n<!-- i18n:id=install -->\n推荐用包管理器安装，也可用 CDN\n\n<!-- i18n:id=intro -->\n介绍\n`

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-test-'))
  db = await openDb(path.join(tmpDir, 't.sqlite'))
})
after(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const pair = (reader, srcNid) => reader.pairs.find((p) => p.srcNid === srcNid)

test('摄入 v1 双语并建立 confirmed 边（非下标）', () => {
  ingestVersion(db, { docId: 'd', lang: 'zh', raw: ZH_V1, title: 'T' })
  ingestVersion(db, { docId: 'd', lang: 'en', raw: EN_V1, title: 'T' })
  const r = getReader(db, { docId: 'd' })
  assert.equal(r.pairs.length, 2)
  assert.ok(pair(r, 'intro'))
  assert.ok(pair(r, 'install'))
})

test('翻译审阅通过 => verified；基线指向原文 v1', () => {
  saveTranslation(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', content: 'Intro', actor: 'a' })
  reviewTranslation(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', status: 'verified', reviewer: 'r' })
  saveTranslation(db, { docId: 'd', srcNid: 'install', tgtNid: 'en-install', content: 'Install with NPM', actor: 'a' })
  reviewTranslation(db, { docId: 'd', srcNid: 'install', tgtNid: 'en-install', status: 'verified', reviewer: 'r' })
  const r = getReader(db, { docId: 'd' })
  assert.equal(pair(r, 'intro').status.effective, 'verified')
  assert.equal(pair(r, 'intro').status.baselineVersion, 1)
})

test('原文改版：未改段保留 verified，改动段变 stale（待复核）', () => {
  ingestVersion(db, { docId: 'd', lang: 'zh', raw: ZH_V2 })
  const r = getReader(db, { docId: 'd' })
  assert.equal(pair(r, 'intro').status.effective, 'verified')
  assert.equal(pair(r, 'install').status.effective, 'stale')
})

test('重新审阅后恢复 verified，基线更新到当前原文版本', () => {
  saveTranslation(db, { docId: 'd', srcNid: 'install', tgtNid: 'en-install', content: 'Use a package manager or CDN', actor: 'a' })
  reviewTranslation(db, { docId: 'd', srcNid: 'install', tgtNid: 'en-install', status: 'verified', reviewer: 'r' })
  const r = getReader(db, { docId: 'd' })
  assert.equal(pair(r, 'install').status.effective, 'verified')
  assert.equal(pair(r, 'install').status.baselineVersion, 2)
})

test('章节重排：ord 变化但 nid 不变，对齐与已验状态全部保留', () => {
  const bodyNids = (r) => r.columns.source.filter((b) => b.kind !== 'heading').map((b) => b.nid)
  const before = getReader(db, { docId: 'd' })
  ingestVersion(db, { docId: 'd', lang: 'zh', raw: ZH_V3 })
  const after = getReader(db, { docId: 'd' })
  assert.deepEqual(bodyNids(after), [...bodyNids(before)].reverse())
  assert.equal(pair(after, 'intro').status.effective, 'verified')
  assert.equal(pair(after, 'install').status.effective, 'verified')
})

test('某语言暂缺：targetMissing 结构化返回，不伪造同步', () => {
  ingestVersion(db, { docId: 'onlyzh', lang: 'zh', raw: `# Z\n\n<!-- i18n:id=p -->\n只有中文\n`, title: 'Z' })
  const r = getReader(db, { docId: 'onlyzh' })
  assert.equal(r.targetMissing, true)
  assert.deepEqual(r.pairs, [])
  assert.equal(r.columns.source.length, 2)
})

test('整篇语言锁：他人持锁时保存被 423 拒绝；锁释放后可保存', () => {
  acquireLock(db, { docId: 'd', lang: 'en', actor: 'owner-a', ttl: 600 })
  assert.throws(
    () => saveTranslation(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', content: 'Intro x', actor: 'translator-b' }),
    (e) => e instanceof HttpError && e.status === 423 && e.code === 'language-locked'
  )
  // 锁主人自己可以保存
  assert.doesNotThrow(() =>
    saveTranslation(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', content: 'Intro x', actor: 'owner-a' })
  )
  releaseLock(db, { docId: 'd', lang: 'en', actor: 'owner-a' })
})

test('段落级锁 + 乐观并发：两译者编辑同段', async () => {
  // 场景 A：译者 a 显式持有段落锁，译者 b 直接保存被 423 拒绝
  saveTranslation(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', content: 'Intro x', actor: 'a' })
  acquireSegmentLock(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', actor: 'a', ttl: 120 })
  assert.throws(
    () =>
      saveTranslation(db, {
        docId: 'd',
        srcNid: 'intro',
        tgtNid: 'en-intro',
        content: 'Intro by B while locked',
        actor: 'b'
      }),
    (e) => e.status === 423 && e.code === 'segment-locked'
  )

  // 场景 B：无锁但基于旧内容提交 -> 乐观并发 409（两译者都打开旧版）
  db.run("UPDATE translations SET lock_owner=NULL, lock_until=NULL WHERE doc_id='d' AND src_nid='intro'")
  const oldHash = createHash('sha1').update('Intro x').digest('hex')
  saveTranslation(db, { docId: 'd', srcNid: 'intro', tgtNid: 'en-intro', content: 'Intro by B', actor: 'b' })
  assert.throws(
    () =>
      saveTranslation(db, {
        docId: 'd',
        srcNid: 'intro',
        tgtNid: 'en-intro',
        content: 'Intro by A',
        actor: 'a',
        expectedContentHash: oldHash
      }),
    (e) => e.status === 409 && e.code === 'translation-conflict'
  )
})

test('受保护片段：译文丢失 `param` 被 422 拒绝', () => {
  ingestVersion(db, { docId: 'prot', lang: 'zh', raw: `# P\n\n<!-- i18n:id=p -->\n使用 \`paramX\` 配置\n`, title: 'P' })
  ingestVersion(db, { docId: 'prot', lang: 'en', raw: `# P\n\n<!-- i18n:id=en-p xref=p -->\nconfigure via paramX\n`, title: 'P' })
  assert.throws(
    () => saveTranslation(db, { docId: 'prot', srcNid: 'p', tgtNid: 'en-p', content: 'configure via paramX', actor: 'a' }),
    (e) => e.status === 422 && e.details.missing.includes('paramX')
  )
  assert.doesNotThrow(() =>
    saveTranslation(db, { docId: 'prot', srcNid: 'p', tgtNid: 'en-p', content: 'configure via `paramX`', actor: 'a' })
  )
})

test('来源缺失 + 人工确认入口：manualPair 建立确认边', () => {
  ingestVersion(db, { docId: 'ms', lang: 'zh', raw: `# M\n\n<!-- i18n:id=real -->\n存在\n`, title: 'M' })
  ingestVersion(db, { docId: 'ms', lang: 'en', raw: `# M\n\n<!-- i18n:id=en-dangling xref=ghost -->\nDangling\n`, title: 'M' })
  let r = getReader(db, { docId: 'ms' })
  assert.equal(r.diagnostics.missingSource[0].ref, 'ghost')
  // 人工把悬空译文与真实原文配对
  const tgtNid = r.diagnostics.missingSource[0].tgtNid
  manualPair(db, { docId: 'ms', srcNid: 'real', tgtNid, actor: 'editor' })
  r = getReader(db, { docId: 'ms' })
  assert.ok(r.pairs.some((p) => p.srcNid === 'real' && p.tgtNid === tgtNid && p.edgeStatus === 'confirmed'))
})

test('人工 reject 边：decideEdge 后该边退出配对图', () => {
  const r = getReader(db, { docId: 'ms' })
  const edgeId = r.pairs.find((p) => p.srcNid === 'real').edgeId
  decideEdge(db, { edgeId, decision: 'rejected', actor: 'editor' })
  rebuildEdges(db, 'ms', 'zh', 'en')
  const after = getReader(db, { docId: 'ms' })
  assert.ok(!after.pairs.some((p) => p.srcNid === 'real' && p.edgeStatus !== 'rejected'))
})

test('搜索当前版，可按 version 进入历史版', () => {
  const cur = search(db, { q: 'CDN', lang: 'zh' })
  assert.ok(cur.hits.some((h) => h.docId === 'd'))
  const v1 = search(db, { q: 'NPM', lang: 'zh', docId: 'd', version: 1 })
  assert.equal(v1.hits.length > 0, true)
  assert.equal(v1.hits.every((h) => h.version === 1), true)
})

test('历史版阅读器明确标注版本：基于哪版原文、是否最新、不冒充同步', () => {
  const old = getReader(db, { docId: 'd', srcVersion: 1 })
  assert.equal(old.srcVersion, 1)
  assert.equal(old.srcIsLatest, false)
  assert.equal(old.srcCurrentVersion, 3)
  const latest = getReader(db, { docId: 'd' })
  assert.equal(latest.srcIsLatest, true)
})

test('版本历史完整可列', () => {
  const zhVs = versions(db, 'd').filter((v) => v.lang === 'zh').map((v) => v.version)
  const enVs = versions(db, 'd').filter((v) => v.lang === 'en').map((v) => v.version)
  assert.deepEqual(zhVs, [1, 2, 3])
  assert.deepEqual(enVs, [1])
})

test('代码更新：共享 codeRef 只存一份，双语列同步反映且不复制正文代码', () => {
  const zh = `# C\n\n<!-- i18n:id=c-code code=demo-code lang=bash -->\n\`\`\`bash\nnpm i x\n\`\`\`\n`
  const en = `# C\n\n<!-- i18n:id=c-code code=demo-code lang=bash -->\n\`\`\`bash\nnpm i x\n\`\`\`\n`
  ingestVersion(db, { docId: 'codeupd', lang: 'zh', raw: zh, title: 'C' })
  ingestVersion(db, { docId: 'codeupd', lang: 'en', raw: en, title: 'C' })
  const v1 = getReader(db, { docId: 'codeupd' })
  assert.ok(v1.pairs.some((p) => p.origin === 'code'))
  ingestVersion(db, { docId: 'codeupd', lang: 'zh', raw: zh.replace('npm i x', 'npm i x@2'), title: 'C' })
  const v2 = getReader(db, { docId: 'codeupd' })
  const srcCode = v2.columns.source.find((b) => b.nid === 'c-code').code.content
  const tgtCode = v2.columns.target.find((b) => b.nid === 'c-code').code.content
  assert.equal(srcCode.includes('x@2'), true)
  assert.equal(tgtCode, srcCode) // 同一 codeRef，引用一致
})

test('对齐冲突：拆段(1:n)与合并(n:1)交叉 -> ambiguous 诊断', () => {
  const zh = `# X\n\n<!-- i18n:id=a -->\n甲\n\n<!-- i18n:id=b -->\n乙\n`
  // t1 合并(a,b)；t2 又拆 a -> t1 同时属于 n:1 且 a 属于 1:n，交叉
  const en = `# X\n\n<!-- i18n:id=t1 xref=a -->\nM1\n\n<!-- i18n:id=t1m xref=b -->\nM1b\n\n<!-- i18n:id=t2 xref=a -->\nA2\n`
  ingestVersion(db, { docId: 'amb', lang: 'zh', raw: zh, title: 'X' })
  ingestVersion(db, { docId: 'amb', lang: 'en', raw: en.replace('xref=a -->\nM1', 'xref=a xref=b -->\nMerged'), title: 'X' })
  const r = getReader(db, { docId: 'amb' })
  assert.ok(r.diagnostics.ambiguous.length >= 1, '应有交叉边标记 ambiguous')
  assert.ok(r.pairs.some((p) => p.conflict === 'ambiguous'))
})
