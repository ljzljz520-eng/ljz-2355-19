// 领域逻辑：版本发布、语义对齐、翻译基线、审阅状态、乐观锁、语言锁比对
import { now } from './db.js'
import { hash, assignKeys, checkUntranslatable } from './segmenter.js'

export class ConflictError extends Error {
  constructor(message, current) { super(message); this.code = 'CONFLICT'; this.current = current }
}

// ---------- 基础查询 ----------
export const getDoc = (db, docId) => db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)

export function latestVersion(db, docId, lang) {
  return db.prepare(
    'SELECT * FROM doc_versions WHERE doc_id = ? AND lang = ? ORDER BY version_no DESC LIMIT 1'
  ).get(docId, lang)
}

export function getVersion(db, docId, lang, versionNo) {
  return versionNo == null
    ? latestVersion(db, docId, lang)
    : db.prepare('SELECT * FROM doc_versions WHERE doc_id = ? AND lang = ? AND version_no = ?').get(docId, lang, versionNo)
}

export const segmentsOf = (db, versionId) =>
  db.prepare('SELECT * FROM segments WHERE version_id = ? ORDER BY seq').all(versionId)

export function listDocuments(db) {
  const docs = db.prepare('SELECT * FROM documents ORDER BY id').all()
  return docs.map((d) => {
    const langs = db.prepare(
      'SELECT lang, MAX(version_no) AS latest, COUNT(*) AS versions FROM doc_versions WHERE doc_id = ? GROUP BY lang'
    ).all(d.id)
    return { ...d, lock: d.lock_json ? JSON.parse(d.lock_json) : null, langs }
  })
}

// ---------- 版本发布（含 seg_key 继承与译段状态刷新） ----------
export function publishVersion(db, { docId, lang, blocks, author = 'system', note = '' }) {
  const prev = latestVersion(db, docId, lang)
  const prevSegs = prev ? segmentsOf(db, prev.id) : []
  const keyed = assignKeys(blocks.map((b) => ({ ...b })), prevSegs)
  const versionNo = (prev?.version_no ?? 0) + 1

  const tx = db.transaction(() => {
    const v = db.prepare(
      'INSERT INTO doc_versions (doc_id, lang, version_no, author, note, created_at) VALUES (?,?,?,?,?,?)'
    ).run(docId, lang, versionNo, author, note, now())
    const versionId = v.lastInsertRowid
    keyed.forEach((b, i) => {
      const codeRef = b.type === 'code' ? (b.codeRef ?? `${docId}#code:${b.ordinal ?? i + 1}`) : null
      if (b.type === 'code' && b.content) {
        // 共享代码块：upsert 单一事实来源，译段只存引用
        db.prepare(
          `INSERT INTO code_blocks (id, content, updated_by, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
        ).run(codeRef, b.content, author, now())
      }
      db.prepare(
        'INSERT INTO segments (version_id, seg_key, seg_type, content, code_ref, seq, content_hash) VALUES (?,?,?,?,?,?,?)'
      ).run(versionId, b.key, b.type, b.type === 'code' ? '' : b.content, codeRef, i, hash(b.type === 'code' ? '' : b.content))
    })
  })
  tx()

  // 源语言发布新版本后，刷新所有目标语言的译段状态（只影响基线已漂移的段）
  const doc = getDoc(db, docId)
  if (doc && lang === doc.src_lang) refreshStatuses(db, docId)
  return { versionNo, segments: keyed }
}

// ---------- 对齐图（多对多，人工可确认） ----------
export function setAlignment(db, { docId, srcKey, tgtLang, tgtKeys, confirmed = 0, by = 'system' }) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM alignments WHERE doc_id = ? AND src_key = ? AND tgt_lang = ?').run(docId, srcKey, tgtLang)
    for (const tgtKey of tgtKeys) {
      db.prepare(
        'INSERT OR REPLACE INTO alignments (doc_id, src_key, tgt_lang, tgt_key, confirmed, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(docId, srcKey, tgtLang, tgtKey, confirmed ? 1 : 0, by, now())
    }
  })
  tx()
  return detectConflicts(db, docId, tgtLang)
}

export function alignmentsOf(db, docId, tgtLang) {
  return db.prepare('SELECT * FROM alignments WHERE doc_id = ? AND tgt_lang = ?').all(docId, tgtLang)
}

/** 对齐冲突：同一译段被多个源段声称（一对多只允许源→多目标）→ 标记 conflict，需人工确认 */
export function detectConflicts(db, docId, tgtLang) {
  const rows = db.prepare(
    `SELECT tgt_key, COUNT(DISTINCT src_key) AS n FROM alignments
     WHERE doc_id = ? AND tgt_lang = ? GROUP BY tgt_key HAVING n > 1`
  ).all(docId, tgtLang)
  const mark = db.prepare(
    `INSERT INTO segment_status (doc_id, tgt_lang, tgt_key, status, updated_at) VALUES (?,?,?,'conflict',?)
     ON CONFLICT(doc_id, tgt_lang, tgt_key) DO UPDATE SET status = 'conflict', updated_at = excluded.updated_at`
  )
  for (const r of rows) mark.run(docId, tgtLang, r.tgt_key, now())
  return rows.map((r) => r.tgt_key)
}

// ---------- 翻译基线与审阅状态 ----------
const getStatus = (db, docId, tgtLang, tgtKey) =>
  db.prepare('SELECT * FROM segment_status WHERE doc_id = ? AND tgt_lang = ? AND tgt_key = ?').get(docId, tgtLang, tgtKey)

function srcHashMap(db, docId, srcKeys) {
  const doc = getDoc(db, docId)
  const src = latestVersion(db, docId, doc.src_lang)
  if (!src) return {}
  const segs = segmentsOf(db, src.id)
  const map = {}
  for (const k of srcKeys) {
    const s = segs.find((x) => x.seg_key === k)
    if (s) map[k] = s.content_hash
  }
  return map
}

/** 源版本变化后重算译段状态：仅基线漂移的段 → needs_review / missing_source，未改段保留已验状态 */
export function refreshStatuses(db, docId) {
  const doc = getDoc(db, docId)
  const src = latestVersion(db, docId, doc.src_lang)
  if (!src) return
  const srcSegs = new Map(segmentsOf(db, src.id).map((s) => [s.seg_key, s]))
  const rows = db.prepare('SELECT * FROM segment_status WHERE doc_id = ?').all(docId)
  const upd = db.prepare('UPDATE segment_status SET status = ?, updated_at = ? WHERE doc_id = ? AND tgt_lang = ? AND tgt_key = ?')
  const changed = []
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.status === 'conflict') continue // 冲突需人工解决，不自动迁移
      const srcKeys = JSON.parse(r.base_src_keys)
      const baseHash = JSON.parse(r.base_src_hash)
      const missing = srcKeys.filter((k) => !srcSegs.has(k))
      let next = r.status
      if (srcKeys.length > 0 && missing.length === srcKeys.length) next = 'missing_source'
      else if (srcKeys.some((k) => srcSegs.has(k) && srcSegs.get(k).content_hash !== baseHash[k])) next = 'needs_review'
      else if (r.status === 'missing_source' || r.status === 'needs_review') next = r.status // 需人工确认，不自动恢复
      if (next !== r.status) { upd.run(next, now(), docId, r.tgt_lang, r.tgt_key); changed.push({ tgtKey: r.tgt_key, from: r.status, to: next }) }
    }
  })
  tx()
  return changed
}

/** 提交/更新译段：乐观锁防止两译者互相覆盖；校验不可翻译标记 */
export function submitTranslation(db, { docId, tgtLang, tgtKey, content, translator, expectedLockVersion }) {
  const doc = getDoc(db, docId)
  if (!doc) throw new Error(`document not found: ${docId}`)
  const tgt = latestVersion(db, docId, tgtLang)
  if (!tgt) throw new Error(`no ${tgtLang} version for ${docId}`)
  const cur = getStatus(db, docId, tgtLang, tgtKey)
  if (cur && expectedLockVersion != null && cur.lock_version !== expectedLockVersion) {
    throw new ConflictError(
      `segment "${tgtKey}" was modified by ${cur.translator} (lock_version ${cur.lock_version})`, cur
    )
  }
  // 基于当前目标版本发布新版本（只替换该段内容，保持其余段与版本联系）
  const segs = segmentsOf(db, tgt.id)
  const blocks = segs.map((s) => ({
    key: s.seg_key, type: s.seg_type,
    content: s.seg_key === tgtKey ? content : s.content,
    codeRef: s.code_ref ?? undefined,
  }))
  if (!segs.some((s) => s.seg_key === tgtKey)) throw new Error(`segment not found: ${tgtKey}`)
  const { versionNo } = publishVersion(db, { docId, lang: tgtLang, blocks, author: translator, note: `translate ${tgtKey}` })

  // 记录翻译基线：当前对齐源段的哈希
  const als = db.prepare('SELECT src_key FROM alignments WHERE doc_id = ? AND tgt_lang = ? AND tgt_key = ?').all(docId, tgtLang, tgtKey)
  const srcKeys = als.map((a) => a.src_key)
  const baseHash = srcHashMap(db, docId, srcKeys)
  db.prepare(
    `INSERT INTO segment_status (doc_id, tgt_lang, tgt_key, base_src_keys, base_src_hash, status, translator, lock_version, updated_at)
     VALUES (?,?,?,?,?,'verified',?,1,?)
     ON CONFLICT(doc_id, tgt_lang, tgt_key) DO UPDATE SET
       base_src_keys = excluded.base_src_keys, base_src_hash = excluded.base_src_hash,
       status = 'verified', translator = excluded.translator,
       lock_version = segment_status.lock_version + 1, updated_at = excluded.updated_at`
  ).run(docId, tgtLang, tgtKey, JSON.stringify(srcKeys), JSON.stringify(baseHash), translator, now())

  // 不可翻译标记校验（警告，不阻断）：译文必须保留原文行内代码/参数名等标记
  const srcVer = latestVersion(db, docId, doc.src_lang)
  const srcContents = srcVer ? segmentsOf(db, srcVer.id).filter((s) => srcKeys.includes(s.seg_key)).map((s) => s.content) : []
  const warnings = checkUntranslatable(srcContents.join('\n'), content).map((t) => `missing untranslatable token: ${t}`)
  return { versionNo, tgtKey, status: 'verified', warnings }
}

/** 人工确认：译段与当前原文一致 → verified，并重置基线为当前源哈希 */
export function confirmSegment(db, { docId, tgtLang, tgtKey, reviewer }) {
  const cur = getStatus(db, docId, tgtLang, tgtKey)
  if (!cur) throw new Error(`no status for segment: ${tgtKey}`)
  const als = db.prepare('SELECT src_key FROM alignments WHERE doc_id = ? AND tgt_lang = ? AND tgt_key = ?').all(docId, tgtLang, tgtKey)
  const srcKeys = als.map((a) => a.src_key)
  if (srcKeys.length === 0) throw new Error(`segment "${tgtKey}" has no aligned source; fix alignment first`)
  const baseHash = srcHashMap(db, docId, srcKeys)
  if (Object.keys(baseHash).length < srcKeys.length) throw new Error(`aligned source missing for "${tgtKey}"`)
  db.prepare(
    `UPDATE segment_status SET status = 'verified', base_src_keys = ?, base_src_hash = ?,
     translator = ?, lock_version = lock_version + 1, updated_at = ?
     WHERE doc_id = ? AND tgt_lang = ? AND tgt_key = ?`
  ).run(JSON.stringify(srcKeys), JSON.stringify(baseHash), reviewer, now(), docId, tgtLang, tgtKey)
  return { tgtKey, status: 'verified', confirmedBy: reviewer }
}

/** 直接置为已验证（种子/导入用）：记录当前对齐源段哈希为基线 */
export function markVerified(db, { docId, tgtLang, tgtKey, translator = 'seed' }) {
  const als = db.prepare('SELECT src_key FROM alignments WHERE doc_id = ? AND tgt_lang = ? AND tgt_key = ?').all(docId, tgtLang, tgtKey)
  const srcKeys = als.map((a) => a.src_key)
  const baseHash = srcHashMap(db, docId, srcKeys)
  db.prepare(
    `INSERT INTO segment_status (doc_id, tgt_lang, tgt_key, base_src_keys, base_src_hash, status, translator, lock_version, updated_at)
     VALUES (?,?,?,?,?,'verified',?,1,?)
     ON CONFLICT(doc_id, tgt_lang, tgt_key) DO UPDATE SET
       base_src_keys = excluded.base_src_keys, base_src_hash = excluded.base_src_hash,
       status = 'verified', translator = excluded.translator,
       lock_version = segment_status.lock_version + 1, updated_at = excluded.updated_at`
  ).run(docId, tgtLang, tgtKey, JSON.stringify(srcKeys), JSON.stringify(baseHash), translator, now())
}

/** 共享代码更新：一处修改，两种语言同时生效，译段不复制代码 */
export function updateCodeBlock(db, { id, content, by = 'system' }) {
  db.prepare(
    `INSERT INTO code_blocks (id, content, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(id, content, by, now())
  return db.prepare('SELECT * FROM code_blocks WHERE id = ?').get(id)
}

// ---------- 双语视图（按语义节点配对，不按数组下标） ----------
export function getBilingual(db, { docId, tgtLang, srcVersionNo = null, tgtVersionNo = null }) {
  const doc = getDoc(db, docId)
  if (!doc) throw new Error(`document not found: ${docId}`)
  const srcVer = getVersion(db, docId, doc.src_lang, srcVersionNo)
  if (!srcVer) throw new Error(`no ${doc.src_lang} version for ${docId}`)
  const tgtVer = getVersion(db, docId, tgtLang, tgtVersionNo)
  const srcLatest = latestVersion(db, docId, doc.src_lang)
  const tgtLatest = latestVersion(db, docId, tgtLang)

  const srcSegs = segmentsOf(db, srcVer.id).map(hydrate(db))
  const tgtSegs = tgtVer ? segmentsOf(db, tgtVer.id).map(hydrate(db)) : []
  const als = alignmentsOf(db, docId, tgtLang)
  const bySrc = new Map()
  for (const a of als) {
    if (!bySrc.has(a.src_key)) bySrc.set(a.src_key, [])
    bySrc.get(a.src_key).push(a)
  }
  const tgtByKey = new Map(tgtSegs.map((s) => [s.seg_key, s]))
  const claimed = new Set()

  const pairs = srcSegs.map((s) => {
    const links = bySrc.get(s.seg_key) ?? []
    const tgts = links.map((l) => {
      const t = tgtByKey.get(l.tgt_key)
      if (t) claimed.add(l.tgt_key)
      const st = getStatus(db, docId, tgtLang, l.tgt_key)
      return { link: l, segment: t ?? null, status: st ? decorateStatus(st, srcSegs) : null }
    })
    return { src: s, targets: tgts, status: pairStatus(tgts) }
  })

  const unmatchedSrc = pairs.filter((p) => p.targets.length === 0).map((p) => p.src)
  const orphanTgt = tgtSegs.filter((t) => !claimed.has(t.seg_key)).map((t) => ({
    segment: t,
    status: decorateStatus(getStatus(db, docId, tgtLang, t.seg_key), srcSegs),
  }))

  // 汇总：按唯一译段去重（一对多/冲突时段会出现在多个 pair），孤儿段（来源缺失）也计入
  const summary = { verified: 0, needs_review: 0, missing_source: 0, conflict: 0, draft: 0, untranslated: unmatchedSrc.length, orphan: orphanTgt.length }
  const counted = new Set()
  const tally = (tgtKey, st) => {
    if (counted.has(tgtKey)) return
    counted.add(tgtKey)
    if (summary[st] != null) summary[st]++
  }
  for (const p of pairs) for (const t of p.targets) tally(t.link.tgt_key, t.status?.status ?? 'draft')
  for (const o of orphanTgt) tally(o.segment.seg_key, o.status?.status ?? 'draft')

  // 翻译基于哪版原文：取所有已验/待复核段基线哈希对应的源版本（最早漂移版本）
  const basedOn = translationBaseVersion(db, docId, tgtLang)
  const lock = doc.lock_json ? JSON.parse(doc.lock_json) : null
  const fullySynced = !!tgtVer && tgtVer.version_no === tgtLatest?.version_no &&
    srcVer.version_no === srcLatest.version_no &&
    summary.needs_review === 0 && summary.missing_source === 0 && summary.conflict === 0 &&
    summary.untranslated === 0 && summary.orphan === 0

  return {
    docId, title: doc.title, srcLang: doc.src_lang, tgtLang,
    src: { versionNo: srcVer.version_no, latestVersionNo: srcLatest.version_no, isLatest: srcVer.id === srcLatest.id, segments: srcSegs },
    tgt: tgtVer
      ? { versionNo: tgtVer.version_no, latestVersionNo: tgtLatest?.version_no ?? null, isLatest: tgtVer.id === tgtLatest?.id, segments: tgtSegs }
      : null, // 某语言暂缺：tgt 为 null，前端显示未翻译而非报错
    pairs, unmatchedSrc, orphanTgt, summary, lock,
    banner: {
      basedOnSrcVersion: basedOn,
      currentSrcVersion: srcLatest.version_no,
      tgtVersionNo: tgtVer?.version_no ?? null,
      stale: basedOn != null && basedOn < srcLatest.version_no,
      fullySynced, // 过期译文绝不会得到 fullySynced=true
    },
  }
}

function hydrate(db) {
  const getCode = db.prepare('SELECT * FROM code_blocks WHERE id = ?')
  return (s) => {
    if (s.seg_type === 'code' && s.code_ref) {
      const cb = getCode.get(s.code_ref)
      return { ...s, code: cb ?? null } // 代码来自共享块，非段落副本
    }
    return s
  }
}

function decorateStatus(st, srcSegs) {
  if (!st) return null
  const baseHash = JSON.parse(st.base_src_hash)
  const srcByKey = new Map(srcSegs.map((s) => [s.seg_key, s]))
  const drifted = Object.entries(baseHash)
    .filter(([k, h]) => srcByKey.has(k) && srcByKey.get(k).content_hash !== h)
    .map(([k]) => k)
  return { ...st, base_src_keys: JSON.parse(st.base_src_keys), base_src_hash: baseHash, driftedSrcKeys: drifted }
}

function pairStatus(targets) {
  if (targets.length === 0) return 'untranslated'
  const order = ['conflict', 'missing_source', 'needs_review', 'draft', 'verified']
  let worst = 'verified'
  for (const t of targets) {
    const st = t.status?.status ?? 'draft'
    if (order.indexOf(st) < order.indexOf(worst)) worst = st
  }
  return worst
}

/** 译文整体基于哪版原文：所有状态行基线哈希命中的最低源版本号 */
function translationBaseVersion(db, docId, tgtLang) {
  const doc = getDoc(db, docId)
  const rows = db.prepare(
    `SELECT DISTINCT base_src_hash FROM segment_status WHERE doc_id = ? AND tgt_lang = ? AND base_src_hash != '{}'`
  ).all(docId, tgtLang)
  if (!rows.length) return null
  const versions = db.prepare('SELECT * FROM doc_versions WHERE doc_id = ? AND lang = ? ORDER BY version_no').all(docId, doc.src_lang)
  const segByVersion = new Map(versions.map((v) => [v.version_no, new Map(segmentsOf(db, v.id).map((s) => [s.seg_key, s.content_hash]))]))
  let min = null
  for (const r of rows) {
    const base = JSON.parse(r.base_src_hash)
    let found = null
    for (const v of versions) {
      const m = segByVersion.get(v.version_no)
      if ([...Object.entries(base)].every(([k, h]) => m.get(k) === h)) { found = v.version_no; break }
    }
    if (found != null && (min == null || found < min)) min = found
  }
  return min
}

// ---------- 整篇语言锁 vs 段落级对齐图 ----------
export function lockDocument(db, { docId, tgtLang, by = 'system' }) {
  const doc = getDoc(db, docId)
  const src = latestVersion(db, docId, doc.src_lang)
  const tgt = latestVersion(db, docId, tgtLang)
  if (!src || !tgt) throw new Error('both language versions are required to lock')
  const view = getBilingual(db, { docId, tgtLang })
  const bad = view.summary.needs_review + view.summary.missing_source + view.summary.conflict + view.summary.untranslated + view.summary.orphan
  if (bad > 0) {
    const e = new Error(`cannot lock: ${bad} segment(s) not verified`)
    e.blockers = view.pairs.filter((p) => p.status !== 'verified').map((p) => ({ srcKey: p.src.seg_key, status: p.status }))
    throw e
  }
  const lock = { srcVersion: src.version_no, tgtLang, tgtVersion: tgt.version_no, lockedBy: by, lockedAt: now() }
  db.prepare('UPDATE documents SET lock_json = ? WHERE id = ?').run(JSON.stringify(lock), docId)
  return lock
}

export function unlockDocument(db, { docId }) {
  db.prepare('UPDATE documents SET lock_json = NULL WHERE id = ?').run(docId)
}

/** 比较整篇语言锁与段落级对齐图：锁说"同步"，图说"漂移"时以图为准并明确展示 */
export function getSyncReport(db, { docId, tgtLang }) {
  const doc = getDoc(db, docId)
  const view = getBilingual(db, { docId, tgtLang })
  const lock = doc.lock_json ? JSON.parse(doc.lock_json) : null
  const src = latestVersion(db, docId, doc.src_lang)
  const tgt = latestVersion(db, docId, tgtLang)

  const drifted = view.pairs
    .filter((p) => p.status !== 'verified' && p.status !== 'untranslated')
    .map((p) => ({ srcKey: p.src.seg_key, status: p.status, targets: p.targets.map((t) => t.link.tgt_key) }))

  let lockStatus = 'unlocked'
  if (lock) {
    const versionMatch = lock.srcVersion === src.version_no && lock.tgtVersion === (tgt?.version_no ?? -1)
    if (versionMatch && drifted.length === 0 && view.summary.untranslated === 0 && view.summary.orphan === 0) lockStatus = 'in_sync'
    else if (versionMatch) lockStatus = 'broken' // 版本未变但段落图已漂移（如对齐被改）
    else lockStatus = 'stale' // 锁定的版本对已过气
  }
  return {
    docId, tgtLang, lock, lockStatus,
    currentVersions: { src: src.version_no, tgt: tgt?.version_no ?? null },
    graphSummary: view.summary,
    drifted,
    // 结论：是否可以把当前译文当作"与原文完全同步"展示 —— 只有 in_sync 才可以
    presentableAsSynced: lockStatus === 'in_sync',
  }
}

// ---------- 版本历史与搜索（可进入历史版） ----------
export function listVersions(db, docId, lang) {
  return db.prepare(
    `SELECT v.*, (SELECT COUNT(*) FROM segments s WHERE s.version_id = v.id) AS segments
     FROM doc_versions v WHERE v.doc_id = ? AND v.lang = ? ORDER BY v.version_no DESC`
  ).all(docId, lang)
}

export function search(db, { q, lang = null }) {
  const like = `%${q}%`
  const rows = db.prepare(
    `SELECT s.seg_key, s.seg_type, s.content, s.seq, v.doc_id, v.lang, v.version_no, v.created_at,
            (SELECT MAX(version_no) FROM doc_versions WHERE doc_id = v.doc_id AND lang = v.lang) AS latest_no
     FROM segments s JOIN doc_versions v ON v.id = s.version_id
     WHERE s.content LIKE ? ${lang ? 'AND v.lang = ?' : ''}
     ORDER BY v.doc_id, v.lang, v.version_no DESC, s.seq`
  ).all(...(lang ? [like, lang] : [like]))
  return rows.map((r) => ({
    docId: r.doc_id, lang: r.lang, versionNo: r.version_no, segKey: r.seg_key, segType: r.seg_type,
    snippet: r.content.slice(0, 160), isLatest: r.version_no === r.latest_no, createdAt: r.created_at,
  }))
}
