import { groupHashFor, buildGroups } from '../align/align.js'

const now = () => Date.now()
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })

function docSourceLang(db, docId) {
  const d = db.prepare('SELECT doc_id, source_lang FROM documents WHERE doc_id=? OR slug=?').get(docId, docId)
  if (!d) throw err(404, 'document not found')
  return d
}

export function getUnit(db, doc, srcNodeKey, tgtLang) {
  const d = docSourceLang(db, doc)
  const u = db.prepare('SELECT * FROM translation_units WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=?')
    .get(d.doc_id, d.source_lang, srcNodeKey, tgtLang)
  if (!u) throw err(404, `translation unit not found: ${srcNodeKey} -> ${tgtLang}`)
  return u
}

function history(db, docId, srcNodeKey, tgtLang, action, actor, detail = {}) {
  db.prepare(`INSERT INTO unit_history(doc_id, src_node_key, tgt_lang, action, actor, at, detail_json)
    VALUES (?,?,?,?,?,?,?)`).run(docId, srcNodeKey, tgtLang, action, actor, now(), JSON.stringify(detail))
}

/**
 * 保存译文（乐观锁）。clientBaseRevision 必须等于服务端 revision，
 * 否则说明有另一位译者已提交 -> 409，落 edit_conflicts，供人工确认/合并入口处理。
 */
export function saveUnit(db, { doc, srcNodeKey, tgtLang, body, actor, baseRevision }) {
  const d = docSourceLang(db, doc)
  const u = getUnit(db, d.doc_id, srcNodeKey, tgtLang)
  if (baseRevision == null) throw err(400, 'baseRevision is required')
  if (baseRevision !== u.revision) {
    const info = db.prepare(`INSERT INTO edit_conflicts
      (doc_id, src_node_key, tgt_lang, actor, at, base_revision, server_revision, attempted_body, resolved)
      VALUES (?,?,?,?,?,?,?,?,0)`).run(d.doc_id, srcNodeKey, tgtLang, actor || 'unknown', now(),
      baseRevision, u.revision, body)
    db.prepare(`INSERT INTO review_queue(doc_id, kind, ref_key, lang, detail_json, status, created_at)
      VALUES (?, 'edit_conflict', ?, ?, ?, 'open', ?)`)
      .run(d.doc_id, String(info.lastInsertRowid), tgtLang,
        JSON.stringify({ srcNodeKey, actor, baseRevision, serverRevision: u.revision }), now())
    history(db, d.doc_id, srcNodeKey, tgtLang, 'save_conflict', actor || 'unknown', { baseRevision, serverRevision: u.revision })
    throw err(409, 'revision conflict: another translator saved this segment first', {
      conflictId: info.lastInsertRowid, serverRevision: u.revision, serverBody: u.body
    })
  }
  const next = u.status === 'verified' ? 'stale' : (u.status === 'untranslated' ? 'draft' : u.status)
  db.prepare(`UPDATE translation_units SET body=?, body_raw=?, status=?, updated_by=?, updated_at=?, revision=revision+1
    WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=?`)
    .run(body, body, next, actor, now(), d.doc_id, d.source_lang, srcNodeKey, tgtLang)
  history(db, d.doc_id, srcNodeKey, tgtLang, 'save', actor, { revision: u.revision + 1, nextStatus: next })
  return getUnit(db, d.doc_id, srcNodeKey, tgtLang)
}

/** 提交复核：基线 = 当前源版本该组的内容 hash 清单 */
export function submitUnit(db, { doc, srcNodeKey, tgtLang, actor }) {
  const d = docSourceLang(db, doc)
  const u = getUnit(db, d.doc_id, srcNodeKey, tgtLang)
  if (!u.body) throw err(400, 'cannot submit an empty translation')
  const srcVer = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(d.doc_id, d.source_lang).v
  const keys = groupSrcKeys(db, d.doc_id, d.source_lang, tgtLang, srcNodeKey)
  const gsha = groupHashFor(db, d.doc_id, d.source_lang, srcVer, keys)
  db.prepare(`UPDATE translation_units
    SET status='in_review', updated_by=?, updated_at=?, revision=revision+1,
        baseline_group_sha=?, baseline_version=?
    WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=?`)
    .run(actor, now(), gsha, srcVer, d.doc_id, d.source_lang, srcNodeKey, tgtLang)
  recordBaselines(db, d.doc_id, keys, tgtLang, srcVer, gsha, 0)
  history(db, d.doc_id, srcNodeKey, tgtLang, 'submit', actor, { baselineVersion: srcVer, groupSha: gsha })
  return getUnit(db, d.doc_id, srcNodeKey, tgtLang)
}

/** 验收通过：verified + 固化 verified_group_sha；原文未变时该状态会一直保留 */
export function verifyUnit(db, { doc, srcNodeKey, tgtLang, reviewer }) {
  const d = docSourceLang(db, doc)
  const u = getUnit(db, d.doc_id, srcNodeKey, tgtLang)
  if (!u.body) throw err(400, 'cannot verify an empty translation')
  const srcVer = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(d.doc_id, d.source_lang).v
  const keys = groupSrcKeys(db, d.doc_id, d.source_lang, tgtLang, srcNodeKey)
  const gsha = groupHashFor(db, d.doc_id, d.source_lang, srcVer, keys)
  db.prepare(`UPDATE translation_units
    SET status='verified', reviewer=?, updated_by=?, updated_at=?, revision=revision+1,
        baseline_group_sha=?, baseline_version=?, verified_group_sha=?
    WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=?`)
    .run(reviewer, reviewer, now(), gsha, srcVer, gsha, d.doc_id, d.source_lang, srcNodeKey, tgtLang)
  recordBaselines(db, d.doc_id, keys, tgtLang, srcVer, gsha, 1)
  // 解决该节点未决 token_mismatch 审阅项（人已确认）
  db.prepare(`UPDATE review_queue SET status='resolved', resolved_at=?, resolver=?
    WHERE doc_id=? AND status='open' AND lang=? AND (ref_key=? OR detail_json LIKE ?)`)
    .run(now(), reviewer, d.doc_id, tgtLang, srcNodeKey, `%"srcNodeKey":"${srcNodeKey}"%`)
  history(db, d.doc_id, srcNodeKey, tgtLang, 'verify', reviewer, { baselineVersion: srcVer, groupSha: gsha })
  return getUnit(db, d.doc_id, srcNodeKey, tgtLang)
}

function groupSrcKeys(db, docId, srcLang, tgtLang, srcNodeKey) {
  const tgtVer = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, tgtLang).v
  const srcVer = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, srcLang).v
  const groups = buildGroups(db, docId, srcLang, tgtLang, srcVer, tgtVer)
  const g = groups.find((x) => x.src.includes(srcNodeKey))
  return g ? g.src : [srcNodeKey]
}

/** 按源版本为组内每个源节点留痕基线（历史版按当时基线判定，不被最新基线污染） */
function recordBaselines(db, docId, srcKeys, tgtLang, srcVer, gsha, wasVerified) {
  const ups = db.prepare(`INSERT INTO unit_baselines
    (doc_id, src_node_key, tgt_lang, src_version, group_sha, was_verified, recorded_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(doc_id,src_node_key,tgt_lang,src_version)
    DO UPDATE SET group_sha=excluded.group_sha, was_verified=excluded.was_verified, recorded_at=excluded.recorded_at`)
  for (const k of srcKeys) ups.run(docId, k, tgtLang, srcVer, gsha, wasVerified, now())
}

/** 解决编辑冲突：人工合并后的正文落地，冲突关闭 */
export function resolveEditConflict(db, { doc, conflictId, mergedBody, actor }) {
  const d = docSourceLang(db, doc)
  const c = db.prepare('SELECT * FROM edit_conflicts WHERE id=?').get(conflictId)
  if (!c) throw err(404, 'conflict not found')
  const tx = db.transaction(() => {
    db.prepare('UPDATE edit_conflicts SET resolved=1 WHERE id=?').run(conflictId)
    db.prepare(`UPDATE translation_units SET body=?, body_raw=?, status='in_review', updated_by=?, updated_at=?, revision=revision+1
      WHERE doc_id=? AND src_node_key=? AND tgt_lang=?`)
      .run(mergedBody, mergedBody, actor, now(), d.doc_id, c.src_node_key, c.tgt_lang)
    db.prepare(`UPDATE review_queue SET status='resolved', resolved_at=?, resolver=?
      WHERE doc_id=? AND kind='edit_conflict' AND ref_key=?`)
      .run(now(), actor, d.doc_id, String(conflictId))
    // 找到对应 queue id
    const q = db.prepare(`SELECT id FROM review_queue WHERE doc_id=? AND kind='edit_conflict' AND ref_key=? ORDER BY id DESC LIMIT 1`)
      .get(d.doc_id, String(conflictId))
    if (q) db.prepare('INSERT INTO review_actions(review_id, actor, action, at, detail_json) VALUES (?,?,?,?,?)')
      .run(q.id, actor, 'merge_conflict', now(), JSON.stringify({ conflictId }))
    history(db, d.doc_id, c.src_node_key, c.tgt_lang, 'conflict_merged', actor, { conflictId })
  })
  tx()
  return getUnit(db, d.doc_id, c.src_node_key, c.tgt_lang)
}

export function setLanguageLock(db, { doc, tgtLang, actor, srcVersion }) {
  const d = docSourceLang(db, doc)
  const v = srcVersion ?? db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(d.doc_id, d.source_lang).v
  db.prepare(`INSERT INTO language_locks(doc_id, tgt_lang, src_version, locked_at, locked_by)
    VALUES (?,?,?,?,?)
    ON CONFLICT(doc_id, tgt_lang) DO UPDATE SET src_version=excluded.src_version,
      locked_at=excluded.locked_at, locked_by=excluded.locked_by`)
    .run(d.doc_id, tgtLang, v, now(), actor)
  return { doc: d.doc_id, tgtLang, srcVersion: v }
}

export function clearLanguageLock(db, { doc, tgtLang }) {
  const d = docSourceLang(db, doc)
  db.prepare('DELETE FROM language_locks WHERE doc_id=? AND tgt_lang=?').run(d.doc_id, tgtLang)
  return { cleared: true }
}

/**
 * 共享代码更新：源端代码块内容变化 -> 只更新源行；对齐到同一 sha 的目标代码节点
 * 由解析器按「引用同一 sha」实时解析，不复制正文。这里重新对齐代码边并返回影响面。
 */
export function updateCodeReference(db, { doc, srcNodeKey, tgtLang }) {
  const d = docSourceLang(db, doc)
  const srcVer = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(d.doc_id, d.source_lang).v
  const sn = db.prepare('SELECT * FROM nodes WHERE doc_id=? AND lang=? AND version_no=? AND node_key=?')
    .get(d.doc_id, d.source_lang, srcVer, srcNodeKey)
  if (!sn || sn.type !== 'code') throw err(400, 'node is not a code block')
  const tgtVer = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(d.doc_id, tgtLang).v
  const edges = db.prepare(`SELECT * FROM alignment_edges WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=? AND status='active'
    AND (origin='manual' OR (src_version=? AND tgt_version=?))`)
    .all(d.doc_id, d.source_lang, srcNodeKey, tgtLang, srcVer, tgtVer)
  return { sourceSha: sn.content_sha, edges: edges.length, note: 'target columns render code_snippets by sha at read time; no copy is stored in translations' }
}

// ---- 审阅台 ----
export function listReviewQueue(db, doc) {
  const d = docSourceLang(db, doc)
  return db.prepare('SELECT * FROM review_queue WHERE doc_id=? ORDER BY status, id').all(d.doc_id)
}

export function actOnReview(db, { doc, reviewId, action, actor, detail = {} }) {
  const d = docSourceLang(db, doc)
  const q = db.prepare('SELECT * FROM review_queue WHERE id=? AND doc_id=?').get(reviewId, d.doc_id)
  if (!q) throw err(404, 'review item not found')
  const tx = db.transaction(() => {
    const newStatus = action === 'ignore' ? 'ignored' : 'resolved'
    db.prepare('UPDATE review_queue SET status=?, resolved_at=?, resolver=? WHERE id=?')
      .run(newStatus, now(), actor, reviewId)
    db.prepare('INSERT INTO review_actions(review_id, actor, action, at, detail_json) VALUES (?,?,?,?,?)')
      .run(reviewId, actor, action, now(), JSON.stringify(detail))
  })
  tx()
  return db.prepare('SELECT * FROM review_queue WHERE id=?').get(reviewId)
}

export function unitHistory(db, doc, srcNodeKey, tgtLang) {
  const d = docSourceLang(db, doc)
  return db.prepare('SELECT * FROM unit_history WHERE doc_id=? AND src_node_key=? AND tgt_lang=? ORDER BY id').all(d.doc_id, srcNodeKey, tgtLang)
}
