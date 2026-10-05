import { groupSha, tokenSig } from '../util/hash.js'
import { extractInline } from '../parser/blocks.js'
import { buildGroups } from './align.js'

/** 正文里的占位符多重集签名（inline code / {{}} 必须在译文里保住同样引用） */
export function bodyTokens(body) {
  const { tokens } = extractInline(body)
  return tokenSig(tokens)
}

function decorate(n) {
  return {
    node_key: n.node_key, ord: n.ord, type: n.type,
    heading_level: n.heading_level, heading_path: n.heading_path,
    section_path: n.section_path,
    explicit_id: !!n.explicit_id,
    content: n.content, raw_content: n.raw_content,
    content_sha: n.content_sha,
    tokens: JSON.parse(n.tokens_json || '[]'),
    code_sha: n.type === 'code' ? n.content_sha : null
  }
}

function pickUnit(units, key, tgtLang) {
  return units.find((u) => u.src_node_key === key && u.tgt_lang === tgtLang) || null
}

function shaList(nodes) {
  return groupSha(nodes.map((n) => ({ node_key: n.node_key, type: n.type, content_sha: n.content_sha })))
}

function lockHash(db, docId, lang, versionNo, keys) {
  const nodes = db.prepare(`SELECT node_key, type, content_sha FROM nodes
    WHERE doc_id=? AND lang=? AND version_no=? AND node_key IN (${keys.map(() => '?').join(',')})`)
    .all(docId, lang, versionNo, ...keys)
  return groupSha(nodes)
}

function openEditConflict(db, docId, srcNodeKey, tgtLang) {
  return !!db.prepare(`SELECT 1 FROM edit_conflicts WHERE doc_id=? AND src_node_key=? AND tgt_lang=? AND resolved=0 LIMIT 1`)
    .get(docId, srcNodeKey, tgtLang)
}

function stripUnit(u) {
  return {
    src_node_key: u.src_node_key, tgt_node_key: u.tgt_node_key,
    body: u.body, status: u.status, reviewer: u.reviewer, assignee: u.assignee,
    revision: u.revision, updated_by: u.updated_by, updated_at: u.updated_at,
    baseline_version: u.baseline_version, baseline_group_sha: u.baseline_group_sha,
    verified_group_sha: u.verified_group_sha
  }
}

function countByStatus(view) {
  const c = {}
  for (const g of view) c[g.status] = (c[g.status] || 0) + 1
  return c
}

/**
 * 双语阅读解析。
 * mode=graph（段落级对齐图）：每组按各自基线独立判定；
 * mode=lock （整篇语言锁）：所有单元以锁定源版本为基线，源版本推进则整篇滞后。
 */
export function resolveReader(db, opts) {
  const { doc, tgtLang, mode = 'graph', srcVersion, tgtVersion } = opts
  const docRow = db.prepare('SELECT * FROM documents WHERE doc_id=? OR slug=?').get(doc, doc)
  if (!docRow) throw Object.assign(new Error('document not found'), { status: 404 })
  const docId = docRow.doc_id
  const srcLang = docRow.source_lang

  const latest = (lang) => db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, lang).v
  const srcLatest = latest(srcLang)
  const tgtLatest = latest(tgtLang)
  if (srcLatest == null) throw Object.assign(new Error('source language has no version'), { status: 409 })

  const srcV = srcVersion ?? srcLatest
  const tgtV = tgtVersion ?? tgtLatest
  const pinnedHistory = srcV !== srcLatest || (tgtLatest != null && tgtV !== tgtLatest)
  const tgtAvailable = tgtV != null

  const srcNodes = db.prepare('SELECT * FROM nodes WHERE doc_id=? AND lang=? AND version_no=? ORDER BY ord').all(docId, srcLang, srcV)
  const tgtNodes = tgtAvailable ? db.prepare('SELECT * FROM nodes WHERE doc_id=? AND lang=? AND version_no=? ORDER BY ord').all(docId, tgtLang, tgtV) : []
  const srcMap = new Map(srcNodes.map((n) => [n.node_key, n]))
  const tgtMap = new Map(tgtNodes.map((n) => [n.node_key, n]))
  const units = db.prepare('SELECT * FROM translation_units WHERE doc_id=? AND tgt_lang=?').all(docId, tgtLang)
  const lock = db.prepare('SELECT * FROM language_locks WHERE doc_id=? AND tgt_lang=?').get(docId, tgtLang)

  // ---- 分组（边只在目标语言有版本时存在意义）----
  const groups = tgtAvailable ? buildGroups(db, docId, srcLang, tgtLang, srcV, tgtV) : []
  const seenSrc = new Set(), seenTgt = new Set()
  const view = groups.map((g) => {
    g.src.forEach((k) => seenSrc.add(k)); g.tgt.forEach((k) => seenTgt.add(k))
    return decorateGroup(g)
  })

  function decorateGroup(g) {
    const sn = g.src.map((k) => srcMap.get(k)).filter(Boolean)
    const tn = g.tgt.map((k) => tgtMap.get(k)).filter(Boolean)
    const srcMissing = g.src.some((k) => !srcMap.has(k))
    const tgtMissing = g.tgt.some((k) => !tgtMap.has(k))
    const allCode = sn.length && sn.every((n) => n.type === 'code')

    const currentGroupSha = shaList(sn)
    const unit = sn[0] ? pickUnit(units, sn[0].node_key, tgtLang) : null

    let status, detail = {}
    if (srcMissing) {
      status = 'source_missing'; detail.reason = 'edge_dangling_source'
    } else if (tgtMissing || tn.length === 0) {
      status = 'missing'; detail.reason = 'target_side_absent'
    } else if (g.origins.includes('manual') && g.origins.includes('auto')) {
      status = 'conflict'; detail.reason = 'manual_and_auto_overlap'
    } else if (allCode) {
      const sSha = sn[0].content_sha
      const same = tn.every((n) => n.type === 'code' && n.content_sha === sSha)
      if (same) status = 'code_synced'
      else { status = 'code_outdated'; detail.reason = 'shared_code_changed_on_source' }
    } else if (!unit) {
      status = 'missing'; detail.reason = 'no_translation_unit'
    } else if (openEditConflict(db, docId, unit.src_node_key, tgtLang)) {
      status = 'conflict'; detail.reason = 'two_translators_edit_conflict'
    } else {
      // token 引用一致性（参数名/不可翻译标记必须保留）。
      // 只在「当前版本视图」检查最新译文；历史版用当时基线判定，不拿今天的译文要求昨天。
      if (!pinnedHistory && unit.body) {
        const want = new Set(sn.flatMap((n) => JSON.parse(n.tokens_json || '[]').map((t) => t.placeholder)))
        const have = new Set(extractInline(unit.body).tokens.map((t) => t.placeholder))
        const missingTokens = [...want].filter((p) => !have.has(p))
        if (missingTokens.length) {
          status = 'conflict'; detail.reason = 'token_mismatch'; detail.missingTokens = missingTokens
        }
      }
      if (status !== 'conflict') {
        // 基线判定：
        //  - 整篇锁：以锁定源版本内容为基线；
        //  - 段落图：查「当前查看源版本」的基线留痕（历史版看当时基线，不被最新版污染）。
        let baseSha, baseVer, wasVerified
        if (mode === 'lock') {
          baseSha = lock ? lockHash(db, docId, srcLang, lock.src_version, g.src) : null
          baseVer = lock ? lock.src_version : null
        } else {
          const bl = db.prepare(`SELECT * FROM unit_baselines
            WHERE doc_id=? AND src_node_key=? AND tgt_lang=? AND src_version=?`)
            .get(docId, unit.src_node_key, tgtLang, srcV)
          baseSha = bl ? bl.group_sha : null
          baseVer = bl ? bl.src_version : null
          wasVerified = bl ? !!bl.was_verified : false
        }
        if (!unit.body) status = 'untranslated'
        else if (mode === 'graph' && baseSha == null) {
          // 当前版本没有新基线：看最近一次「已验收」的历史基线。
          // 若其内容 hash 与当前源不同，说明原文已改而译者未跟进 -> stale 待复核；
          // 从未验收过 -> 草稿/待复核。
          const lastVerified = db.prepare(`SELECT * FROM unit_baselines
            WHERE doc_id=? AND src_node_key=? AND tgt_lang=? AND was_verified=1
            ORDER BY src_version DESC LIMIT 1`).get(docId, unit.src_node_key, tgtLang)
          if (lastVerified && lastVerified.group_sha !== currentGroupSha) {
            status = 'stale'
            detail.baseline = { group_sha: lastVerified.group_sha, src_version: lastVerified.src_version }
          } else if (lastVerified && lastVerified.group_sha === currentGroupSha) {
            // 历史已验收基线与当前内容一致（原文未改）-> 保留 verified
            status = 'verified'
          } else {
            status = unit.status === 'draft' ? 'draft' : 'in_review'
          }
        }
        else if (baseSha == null) status = unit.status === 'draft' ? 'draft' : 'in_review'
        else if (baseSha === currentGroupSha) {
          // 该版本基线与当前内容一致：历史版按当时是否验收显示，现版按单元状态
          status = (mode === 'graph' && wasVerified) || unit.status === 'verified' ? 'verified' : unit.status
        } else { status = 'stale'; detail.baseline = { group_sha: baseSha, src_version: baseVer } }
        detail.current_group_sha = currentGroupSha
      }
    }

    return {
      id: `g-${g.src.join('+')}__${g.tgt.join('+')}`,
      src_keys: g.src, tgt_keys: g.tgt, origins: g.origins,
      status, detail,
      src: sn.map(decorate),
      tgt: tn.map(decorate),
      unit: unit ? stripUnit(unit) : null,
      current_group_sha: currentGroupSha
    }
  }

  // ---- 孤立节点：未被任何边覆盖 ----
  const orphanSrc = srcNodes.filter((n) => !seenSrc.has(n.node_key) && n.type !== 'code')
  const orphanSrcIssues = orphanSrc.map((n) => ({
    kind: 'source_missing', node_key: n.node_key,
    detail: { reason: 'no_alignment_edge', heading_path: n.heading_path, ord: n.ord }
  }))
  const orphanTgt = tgtNodes.filter((n) => !seenTgt.has(n.node_key) && n.type !== 'code')
  const orphanTgtIssues = orphanTgt.map((n) => ({
    kind: 'target_unaligned', node_key: n.node_key,
    detail: { reason: 'no_alignment_edge', heading_path: n.heading_path, ord: n.ord }
  }))

  // 共享代码节点即使没边也要展示（右栏可按 sha 取同一份）
  for (const n of srcNodes.filter((x) => x.type === 'code' && !seenSrc.has(x.node_key))) {
    view.push({
      id: `g-code-${n.node_key}`, src_keys: [n.node_key], tgt_keys: [], origins: [],
      status: 'code_unaligned', detail: { reason: 'shared_code_no_edge' },
      src: [decorate(n)], tgt: [], unit: null, current_group_sha: shaList([n])
    })
  }

  // 有翻译单元、但当前版本无对齐边的正文节点（典型：该语言此节译文暂缺）。
  // 生成 missing 组，让右栏落到「译文缺失 + 补对齐」而不是悄悄丢掉。
  for (const n of orphanSrc.filter((x) => pickUnit(units, x.node_key, tgtLang))) {
    const unit = pickUnit(units, n.node_key, tgtLang)
    view.push({
      id: `g-miss-${n.node_key}`, src_keys: [n.node_key], tgt_keys: [], origins: [],
      status: 'missing', detail: { reason: 'target_side_absent_no_edge' },
      src: [decorate(n)], tgt: [], unit: stripUnit(unit), current_group_sha: shaList([n])
    })
  }

  const openQueue = db.prepare(`SELECT * FROM review_queue WHERE doc_id=? AND status='open' ORDER BY id`).all(docId)

  // ---- 排序：按源列本版顺序（章节重排后两列各自顺序，组内同步滚动）----
  const ordOf = (g) => {
    const k = g.src_keys[0]
    return srcMap.has(k) ? srcMap.get(k).ord : Number.MAX_SAFE_INTEGER
  }
  view.sort((a, b) => ordOf(a) - ordOf(b))

  const textGroups = view.filter((g) => g.src.some((n) => n.type !== 'code'))
  const fullySynced = computeFullySynced({ mode, lock, srcLatest, textGroups, tgtAvailable })
  const banner = buildBanner({ mode, lock, srcLang, tgtLang, srcV, tgtV, srcLatest, tgtLatest, tgtAvailable, pinnedHistory, fullySynced })

  // 共享代码：收集本视图用到的 sha，一次性返回代码正文（两栏引用同一份，译文不复制）
  const shaSet = new Set()
  for (const g of view) {
    for (const n of [...g.src, ...g.tgt]) if (n.type === 'code') shaSet.add(n.code_sha)
  }
  const codeSnippets = {}
  const codeStmt = db.prepare('SELECT sha, language, code FROM code_snippets WHERE sha=?')
  for (const sha of shaSet) { const row = codeStmt.get(sha); if (row) codeSnippets[sha] = { language: row.language, code: row.code } }

  return {
    doc: { id: docId, slug: docRow.slug, title: docRow.title, source_lang: srcLang },
    languages: { source: srcLang, target: tgtLang, target_available: tgtAvailable },
    versions: {
      source: srcV, source_latest: srcLatest,
      target: tgtV ?? null, target_latest: tgtLatest,
      pinned_history: pinnedHistory
    },
    mode,
    lock: lock ? { src_version: lock.src_version, locked_by: lock.locked_by, locked_at: lock.locked_at, stale: lock.src_version !== srcLatest } : null,
    code_snippets: codeSnippets,
    groups: view,
    issues: {
      source_missing: orphanSrcIssues,
      target_unaligned: orphanTgtIssues,
      queue: openQueue.map((q) => ({ id: q.id, kind: q.kind, ref_key: q.ref_key, lang: q.lang, detail: JSON.parse(q.detail_json || '{}') }))
    },
    counts: countByStatus(view),
    fully_synced: fullySynced,
    banner
  }
}

export function computeFullySynced({ mode, lock, srcLatest, textGroups, tgtAvailable }) {
  if (!tgtAvailable) return { value: false, reason: 'target_language_unavailable' }
  if (textGroups.length === 0) return { value: false, reason: 'no_aligned_text' }
  if (mode === 'lock') {
    if (!lock) return { value: false, reason: 'no_lock' }
    if (lock.src_version !== srcLatest) return { value: false, reason: 'lock_behind_source' }
    const bad = textGroups.filter((g) => g.status !== 'verified')
    return bad.length ? { value: false, reason: 'groups_not_verified', pending: bad.length } : { value: true, reason: 'lock_verified' }
  }
  const bad = textGroups.filter((g) => !['verified', 'code_synced'].includes(g.status))
  return bad.length ? { value: false, reason: 'groups_not_current', pending: bad.length } : { value: true, reason: 'all_groups_current' }
}

function buildBanner({ mode, lock, srcLang, tgtLang, srcV, tgtV, srcLatest, tgtLatest, tgtAvailable, pinnedHistory, fullySynced }) {
  if (!tgtAvailable) {
    return { level: 'warning', key: 'lang_missing',
      text: `${tgtLang} 语言版本暂缺，右栏无法显示译文；左栏仍可阅读 ${srcLang} 原文。` }
  }
  if (pinnedHistory) {
    return { level: 'info', key: 'pinned_history',
      text: `当前查看历史版：译文基于原文 v${srcV}（最新 v${srcLatest}），译文侧为 v${tgtV}（最新 v${tgtLatest ?? '—'}）。这是当时快照，不代表当前完全同步。` }
  }
  if (mode === 'lock') {
    if (!lock) return { level: 'info', key: 'lock_none', text: `整篇语言锁未建立；当前只能按段落图逐段跟踪，不能宣称整篇同步。` }
    if (lock.src_version !== srcLatest) {
      return { level: 'warning', key: 'lock_behind',
        text: `整篇锁基于原文 v${lock.src_version}，原文已更新到 v${srcLatest}：整篇标记为滞后，需重新锁定/验收后才能宣称同步。` }
    }
    return fullySynced.value
      ? { level: 'success', key: 'lock_ok', text: `整篇语言锁（基于原文 v${lock.src_version}）全部段落已验收：${srcLang} ↔ ${tgtLang} 当前完全同步。` }
      : { level: 'info', key: 'lock_pending', text: `整篇锁基于原文 v${lock.src_version}，尚有 ${fullySynced.pending ?? 0} 段未验收。` }
  }
  return fullySynced.value
    ? { level: 'success', key: 'graph_ok', text: `段落级对齐：所有译段均已基于原文 v${srcV} 验收，无过期译文。` }
    : { level: 'info', key: 'graph_pending',
        text: `段落级对齐（译文基线：原文 v${srcV}）。部分段落未翻译、待复核或已过期——逐段标注，不会把过期译文包装成完全同步。` }
}
