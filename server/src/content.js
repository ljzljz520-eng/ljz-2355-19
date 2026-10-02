// 内容服务：版本摄入 / 对齐图重建 / 翻译基线状态机 / 锁 / 人工裁决 / 搜索
import { parseDocument } from './parser.js'
import { buildGraph } from './alignment.js'
import { hash, normalize, missingProtected, nowIso, ttlIso } from './util.js'

export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------- 文档/版本

export function listDocs(db) {
  const docs = db.all('SELECT * FROM documents ORDER BY id')
  for (const d of docs) {
    d.langs = db
      .all('SELECT lang, current_ver AS currentVersion FROM doc_langs WHERE doc_id = $d', {
        $d: d.id
      })
      .map((r) => ({ lang: r.lang, currentVersion: r.currentVersion }))
  }
  return docs
}

function nextVersion(db, docId, lang) {
  const row = db.get(
    'SELECT COALESCE(MAX(version),0)+1 AS v FROM doc_versions WHERE doc_id=$d AND lang=$l',
    { $d: docId, $l: lang }
  )
  return row.v
}

/**
 * 摄入一个语言版本。内容 hash 与当前版本一致则不产生新版本（幂等）。
 * @returns {{changed:boolean, version:number}}
 */
export function ingestVersion(db, { docId, lang, raw, title, codeRefs: extraRefs = [] }) {
  const content = normalize(raw)
  const h = hash(content)
  const current = db.get(
    'SELECT v.current_ver AS ver FROM doc_langs v WHERE v.doc_id=$d AND v.lang=$l',
    { $d: docId, $l: lang }
  )
  if (current) {
    const curHash = db.get(
      'SELECT hash FROM doc_versions WHERE doc_id=$d AND lang=$l AND version=$v',
      { $d: docId, $l: lang, $v: current.ver }
    )
    if (curHash?.hash === h) return { changed: false, version: current.ver }
  }

  const { blocks, codeRefs } = parseDocument(raw, lang)
  return db.tx(() => {
    db.run(
      `INSERT INTO documents(id,title,current_ver) VALUES($d,$t,0)
       ON CONFLICT(id) DO UPDATE SET title=COALESCE($t,title)`,
      { $d: docId, $t: title || docId }
    )
    const version = nextVersion(db, docId, lang)
    db.run(
      `INSERT INTO doc_versions(doc_id,version,lang,content,hash) VALUES($d,$v,$l,$c,$h)`,
      { $d: docId, $v: version, $l: lang, $c: content, $h: h }
    )
    for (const b of blocks) {
      db.run(
        `INSERT INTO segments(doc_id,version,lang,nid,ord,kind,level,content,hash,code_ref,nid_auto)
         VALUES($d,$v,$l,$n,$o,$k,$lv,$c,$h,$cr,$a)`,
        {
          $d: docId,
          $v: version,
          $l: lang,
          $n: b.nid,
          $o: b.ord,
          $k: b.kind,
          $lv: b.level ?? null,
          $c: b.content,
          $h: b.hash,
          $cr: b.codeRef,
          $a: b.nidAuto ? 1 : 0
        }
      )
    }
    for (const ref of [...codeRefs, ...extraRefs]) {
      db.run(
        `INSERT INTO code_refs(name,lang_hint,content,hash,updated_at)
         VALUES($n,$l,$c,$h,$t)
         ON CONFLICT(name) DO UPDATE SET lang_hint=$l,content=$c,hash=$h,updated_at=$t`,
        {
          $n: ref.name,
          $l: ref.langHint ?? null,
          $c: ref.content,
          $h: hash(ref.content),
          $t: nowIso()
        }
      )
    }
    db.run(
      `INSERT INTO doc_langs(doc_id,lang,current_ver,updated_at) VALUES($d,$l,$v,$t)
       ON CONFLICT(doc_id,lang) DO UPDATE SET current_ver=$v,updated_at=$t`,
      { $d: docId, $l: lang, $v: version, $t: nowIso() }
    )
    // 有了另一侧语言就为当前版本重建对齐图
    const other = lang === 'zh' ? 'en' : 'zh'
    if (db.get('SELECT 1 FROM doc_langs WHERE doc_id=$d AND lang=$l', { $d: docId, $l: other })) {
      const [a, b] = lang === 'zh' ? ['zh', 'en'] : ['en', 'zh']
      rebuildEdges(db, docId, a, b)
    }
    return { changed: true, version }
  })
}

// ---------------------------------------------------------------- 对齐图

function versionBlocks(db, docId, lang, version) {
  const rows = db.all(
    `SELECT nid, ord, kind, level, content, hash, code_ref AS codeRef, nid_auto AS nidAuto
     FROM segments WHERE doc_id=$d AND lang=$l AND version=$v ORDER BY ord`,
    { $d: docId, $l: lang, $v: version }
  )
  // xref 声明保存在版本内容里：重新解析该版本 markdown 取回
  const ver = db.get(
    'SELECT content FROM doc_versions WHERE doc_id=$d AND lang=$l AND version=$v',
    { $d: docId, $l: lang, $v: version }
  )
  if (!ver) return []
  const parsed = parseDocument(ver.content, lang)
  const xrefByNid = new Map(parsed.blocks.map((b) => [b.nid, b.xrefs]))
  for (const r of rows) r.xrefs = xrefByNid.get(r.nid) || []
  return rows
}

/** 为指定两语言“当前版本”重建并持久化边，保留人工裁决 */
export function rebuildEdges(db, docId, srcLang, tgtLang) {
  const srcVer = db.get('SELECT current_ver AS v FROM doc_langs WHERE doc_id=$d AND lang=$l', {
    $d: docId,
    $l: srcLang
  })?.v
  const tgtVer = db.get('SELECT current_ver AS v FROM doc_langs WHERE doc_id=$d AND lang=$l', {
    $d: docId,
    $l: tgtLang
  })?.v
  if (!srcVer || !tgtVer) return { edges: [], diagnostics: {} }

  const srcBlocks = versionBlocks(db, docId, srcLang, srcVer)
  const tgtBlocks = versionBlocks(db, docId, tgtLang, tgtVer)
  const existing = db.all(
    'SELECT id, src_nid AS srcNid, tgt_nid AS tgtNid, status, origin, conflict FROM alignment_edges WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl',
    { $d: docId, $sl: srcLang, $tl: tgtLang }
  )
  const graph = buildGraph({ srcBlocks, tgtBlocks, existing, keepExisting: true })

    const liveTgtSet = new Set(tgtBlocks.map((b) => b.nid))
  const graphKeys = new Set(graph.edges.map((e) => `${e.srcNid}->${e.tgtNid}`))
  const carriedOrphans = existing.filter(
    (e) => !liveTgtSet.has(e.tgtNid) && !graphKeys.has(`${e.srcNid}->${e.tgtNid}`)
  )

  return db.tx(() => {
    // 删除被作者/人工显式 reject 的边（其余边均在 graph 或 carriedOrphans 中 upsert/保留）
    for (const e of existing) {
      const key = `${e.srcNid}->${e.tgtNid}`
      const inGraph = graphKeys.has(key)
      const orphan = carriedOrphans.some((o) => `${o.srcNid}->${o.tgtNid}` === key)
      if (!inGraph && !orphan && (e.status === 'rejected' || e.conflict === 'orphaned')) {
        db.run('DELETE FROM alignment_edges WHERE id=$i', { $i: e.id })
      }
    }
    for (const e of graph.edges) {
      if (e.id != null) {
        db.run(
          `UPDATE alignment_edges SET rel=$rel,status=$st,conflict=$cf,origin=$or,updated_at=$t WHERE id=$i`,
          { $rel: e.rel, $st: e.status, $cf: e.conflict, $or: e.origin, $i: e.id, $t: nowIso() }
        )
      } else {
        db.run(
          `INSERT INTO alignment_edges(doc_id,src_lang,src_nid,tgt_lang,tgt_nid,rel,status,conflict,origin)
           VALUES($d,$sl,$sn,$tl,$tn,$rel,$st,$cf,$or)`,
          {
            $d: docId,
            $sl: srcLang,
            $sn: e.srcNid,
            $tl: tgtLang,
            $tn: e.tgtNid,
            $rel: e.rel,
            $st: e.status,
            $cf: e.conflict,
            $or: e.origin
          }
        )
      }
    }
    for (const e of carriedOrphans) {
      if (e.conflict !== 'orphaned') {
        db.run(
          `UPDATE alignment_edges SET conflict='orphaned', status=CASE WHEN status='confirmed' THEN 'proposed' ELSE status END,
             updated_at=$t WHERE id=$i`,
          { $t: nowIso(), $i: e.id }
        )
      }
      graph.diagnostics.orphaned = [
        ...(graph.diagnostics.orphaned || []),
        { srcNid: e.srcNid, tgtNid: e.tgtNid, reason: 'target-gone' }
      ]
    }
    // 孤立边恢复（译文版本重新包含该节点）：清除 orphaned 标记
    for (const e of graph.edges) {
      if (e.id != null && e.conflict !== 'ambiguous' && e.conflict !== 'missing-source') {
        db.run("UPDATE alignment_edges SET conflict=NULL WHERE id=$i AND conflict='orphaned'", {
          $i: e.id
        })
      }
    }
    return graph
  })
}

// ---------------------------------------------------------------- 审阅状态

/**
 * 计算一条译边在“查看版本”下的有效状态：
 *   missing-source  原文节点在查看版本中不存在
 *   stale           原文自翻译基线后内容变化（待复核）
 *   verified/draft/in_review 原文未改，保留已验状态
 */
function effectiveStatus(db, docId, srcLang, srcVersion, edge) {
  const cur = db.get(
    'SELECT hash, content FROM segments WHERE doc_id=$d AND lang=$l AND version=$v AND nid=$n',
    { $d: docId, $l: srcLang, $v: srcVersion, $n: edge.srcNid }
  )
  const tr = edge._translation
  if (!cur) return { effective: 'missing-source', reviewStatus: tr?.status ?? null }
  if (!tr) return { effective: 'untranslated', reviewStatus: null, missingTokens: [] }
  const base = db.get(
    'SELECT hash FROM segments WHERE doc_id=$d AND lang=$l AND version=$v AND nid=$n',
    { $d: docId, $l: srcLang, $v: tr.sourceVersion, $n: edge.srcNid }
  )
  let effective = tr.status
  if (!base || base.hash !== cur.hash) effective = 'stale'
  return {
    effective,
    reviewStatus: tr.status,
    baselineVersion: tr.sourceVersion,
    baselineAhead: tr.sourceVersion > srcVersion,
    missingTokens: missingProtected(cur.content, edge.tgtContent ?? tr.content)
  }
}

// ---------------------------------------------------------------- 阅读器装配

export function getReader(db, { docId, srcLang = 'zh', tgtLang = 'en', srcVersion, tgtVersion }) {
  const doc = db.get('SELECT * FROM documents WHERE id=$d', { $d: docId })
  if (!doc) throw new HttpError(404, 'doc-not-found', `文档不存在: ${docId}`)

  const srcRow = db.get('SELECT current_ver AS v FROM doc_langs WHERE doc_id=$d AND lang=$l', {
    $d: docId,
    $l: srcLang
  })
  if (!srcRow) throw new HttpError(404, 'source-missing', `原文语言暂缺: ${srcLang}`)
  const srcVer = srcVersion ?? srcRow.v

  const tgtRow = db.get('SELECT current_ver AS v FROM doc_langs WHERE doc_id=$d AND lang=$l', {
    $d: docId,
    $l: tgtLang
  })
  // 某语言暂缺：显式结构化返回，而不是伪造同步内容
  if (!tgtRow) {
    return {
      doc,
      srcLang,
      tgtLang,
      srcVersion: srcVer,
      srcCurrentVersion: srcRow.v,
      targetMissing: true,
      columns: { source: versionBlocks(db, docId, srcLang, srcVer), target: [] },
      pairs: [],
      diagnostics: { missingLanguage: tgtLang },
      counts: statusCounts([])
    }
  }
  const tgtVer = tgtVersion ?? tgtRow.v

  const srcBlocks = versionBlocks(db, docId, srcLang, srcVer)
  const tgtBlocks = versionBlocks(db, docId, tgtLang, tgtVer)

  // 该版本对的图：以持久边为基础（保留人工裁决），再用版本内 xref 补全
  const persistent = db.all(
    'SELECT * FROM alignment_edges WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl',
    { $d: docId, $sl: srcLang, $tl: tgtLang }
  ).map((r) => ({
    id: r.id,
    srcNid: r.src_nid,
    tgtNid: r.tgt_nid,
    status: r.status,
    rel: r.rel,
    conflict: r.conflict,
    origin: r.origin,
    reviewedBy: r.reviewed_by
  }))
  const graph = buildGraph({
    srcBlocks,
    tgtBlocks,
    existing: persistent.map((e) => ({ ...e })),
    keepExisting: true
  })

  const translations = new Map(
    db.all(
      'SELECT * FROM translations WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl',
      { $d: docId, $sl: srcLang, $tl: tgtLang }
    ).map((r) => [
      `${r.src_nid}->${r.tgt_nid}`,
      {
        srcNid: r.src_nid,
        tgtNid: r.tgt_nid,
        sourceVersion: r.source_version,
        content: r.content,
        contentHash: r.content_hash,
        status: r.status,
        reviewer: r.reviewer,
        lockOwner: r.lock_owner,
        lockUntil: r.lock_until
      }
    ])
  )

  const codeByName = new Map(
    db.all('SELECT name, lang_hint AS langHint, content, hash FROM code_refs').map((r) => [
      r.name,
      r
    ])
  )

  const tgtContentByNid = new Map(tgtBlocks.map((b) => [b.nid, b]))
  const pairs = graph.edges.map((e) => {
    const src = srcBlocks.find((b) => b.nid === e.srcNid) || null
    const tgt = tgtBlocks.find((b) => b.nid === e.tgtNid) || null
    const tr = translations.get(`${e.srcNid}->${e.tgtNid}`) || null
    const enriched = { ...e, _translation: tr, tgtContent: tgt?.content }
    const st = effectiveStatus(db, docId, srcLang, srcVer, enriched)
    return {
      edgeId: e.id ?? null,
      srcNid: e.srcNid,
      tgtNid: e.tgtNid,
      rel: e.rel,
      origin: e.origin,
      edgeStatus: e.status,
      conflict: e.conflict,
      source: src ? decorateCode(src, codeByName) : null,
      target: tgt ? decorateCode(tgt, codeByName) : null,
      translation: tr
        ? {
            baselineVersion: tr.sourceVersion,
            status: tr.status,
            reviewer: tr.reviewer,
            lockOwner: tr.lockOwner,
            lockUntil: tr.lockUntil
          }
        : null,
      status: st,
      reviewedBy: e.reviewedBy || null
    }
  })

  // 孤立边：持久边的译文节点在当前查看版本中消失（章节重排/删除）
  const liveTgt = new Set(tgtBlocks.map((b) => b.nid))
  const liveSrc = new Set(srcBlocks.map((b) => b.nid))
  const orphaned = persistent
    .filter((e) => !liveTgt.has(e.tgtNid) && !graph.edges.some((g) => g.tgtNid === e.tgtNid))
    .map((e) => ({ srcNid: e.srcNid, tgtNid: e.tgtNid, reason: 'target-gone' }))
  const lostSourceEdges = pairs
    .filter((p) => p.status.effective === 'missing-source' || !liveSrc.has(p.srcNid))
    .map((p) => ({ srcNid: p.srcNid, tgtNid: p.tgtNid, reason: 'source-gone' }))

  const diagnostics = {
    ...graph.diagnostics,
    orphaned,
    lostSource: lostSourceEdges
  }

  const locks = activeLocks(db, docId, tgtLang)

  return {
    doc,
    srcLang,
    tgtLang,
    srcVersion: srcVer,
    tgtVersion: tgtVer,
    srcCurrentVersion: srcRow.v,
    tgtCurrentVersion: tgtRow.v,
    srcIsLatest: srcVer === srcRow.v,
    tgtIsLatest: tgtVer === tgtRow.v,
    columns: {
      source: srcBlocks.map((b) => decorateCode(b, codeByName)),
      target: tgtBlocks.map((b) => decorateCode(b, codeByName))
    },
    pairs,
    diagnostics,
    counts: statusCounts(pairs),
    locks
  }
}

function decorateCode(block, codeByName) {
  if (block.kind === 'code' && block.codeRef) {
    const ref = codeByName.get(block.codeRef)
    return { ...block, code: ref ? { ...ref } : { missing: true } }
  }
  return { ...block, code: block.kind === 'code' ? { content: block.content, langHint: block.langHint } : null }
}

function statusCounts(pairs) {
  const counts = {}
  for (const p of pairs) counts[p.status.effective] = (counts[p.status.effective] || 0) + 1
  return counts
}

function activeLocks(db, docId, lang) {
  const t = nowIso()
  return {
    language: db.get(
      'SELECT owner, scope, section, expires_at AS expiresAt FROM doc_locks WHERE doc_id=$d AND lang=$l AND expires_at>$t',
      { $d: docId, $l: lang, $t: t }
    ),
    segments: db.all(
      'SELECT src_nid AS srcNid, tgt_nid AS tgtNid, lock_owner AS owner, lock_until AS until FROM translations WHERE doc_id=$d AND tgt_lang=$l AND lock_until>$t',
      { $d: docId, $l: lang, $t: t }
    )
  }
}

// ---------------------------------------------------------------- 保存译文

/**
 * 保存翻译（含两段并发控制）：
 *  - 整篇语言锁：他人持有 -> 423
 *  - 段落锁：他人持有该 src_nid 段 -> 423
 *  - 乐观并发：expectedContentHash 与库内不一致 -> 409（两译者编辑同段）
 */
export function saveTranslation(db, params) {
  const {
    docId,
    srcLang = 'zh',
    tgtLang = 'en',
    srcNid,
    tgtNid,
    content,
    actor = 'anonymous',
    expectedContentHash = null
  } = params

  const srcVer = db.get('SELECT current_ver AS v FROM doc_langs WHERE doc_id=$d AND lang=$l', {
    $d: docId,
    $l: srcLang
  })?.v
  if (!srcVer) throw new HttpError(404, 'source-missing', '原文不存在')
  const srcSeg = db.get(
    'SELECT content FROM segments WHERE doc_id=$d AND lang=$l AND version=$v AND nid=$n',
    { $d: docId, $l: srcLang, $v: srcVer, $n: srcNid }
  )
  if (!srcSeg) throw new HttpError(404, 'segment-not-found', `原文节点不存在: ${srcNid}`)

  const missing = missingProtected(srcSeg.content, content)
  if (missing.length)
    throw new HttpError(422, 'protected-token-missing', '受保护片段（参数名/不可翻译标记）未原样保留', {
      missing
    })

  const t = nowIso()
  const langLock = db.get(
    'SELECT owner FROM doc_locks WHERE doc_id=$d AND lang=$l AND expires_at>$t',
    { $d: docId, $l: tgtLang, $t: t }
  )
  if (langLock && langLock.owner !== actor)
    throw new HttpError(423, 'language-locked', `语言级锁由 ${langLock.owner} 持有`, {
      owner: langLock.owner
    })

  return db.tx(() => {
    // 段落锁：同 src_nid 任意边被他人锁定即拒绝
    const segLock = db.get(
      'SELECT lock_owner AS owner FROM translations WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn AND lock_until>$t AND lock_owner IS NOT NULL',
      { $d: docId, $sl: srcLang, $tl: tgtLang, $sn: srcNid, $t: t }
    )
    if (segLock && segLock.owner !== actor && !(langLock && langLock.owner === actor))
      throw new HttpError(423, 'segment-locked', `该段落正由 ${segLock.owner} 编辑`, {
        owner: segLock.owner
      })

    const key = {
      $d: docId,
      $sl: srcLang,
      $tl: tgtLang,
      $sn: srcNid,
      $tn: tgtNid || `draft-${srcNid}`
    }
    const existing = db.get(
      'SELECT content_hash AS h, status FROM translations WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn AND tgt_nid=$tn',
      key
    )
    if (existing && expectedContentHash && existing.h !== expectedContentHash) {
      throw new HttpError(409, 'translation-conflict', '该段落已被另一位译者修改，请刷新后合并', {
        serverHash: existing.h
      })
    }

    const ch = hash(content)
    if (existing) {
      db.run(
        `UPDATE translations SET content=$c, content_hash=$h, source_version=$v,
           status=CASE WHEN status='verified' THEN 'in_review' ELSE status END,
           updated_at=$t WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn AND tgt_nid=$tn`,
        { ...key, $c: content, $h: ch, $v: srcVer, $t: t }
      )
    } else {
      db.run(
        `INSERT INTO translations(doc_id,src_lang,src_nid,tgt_lang,tgt_nid,source_version,content,content_hash,status,lock_owner,lock_until)
         VALUES($d,$sl,$sn,$tl,$tn,$v,$c,$h,'draft',$o,$u)`,
        { ...key, $v: srcVer, $c: content, $h: ch, $o: actor, $u: ttlIso(120) }
      )
    }
    log(db, docId, 'save', { srcNid, tgtNid: key.$tn, actor, baseline: srcVer })

    // 新边进入 proposed，等待人工确认入口裁决
    const edge = db.get(
      'SELECT id FROM alignment_edges WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn AND tgt_nid=$tn',
      key
    )
    let edgeId = edge?.id ?? null
    if (!edge) {
      db.run(
        `INSERT INTO alignment_edges(doc_id,src_lang,src_nid,tgt_lang,tgt_nid,rel,status,origin,created_by)
         VALUES($d,$sl,$sn,$tl,$tn,'1:1','proposed','manual',$a)`,
        { ...key, $a: actor }
      )
      edgeId = db.get('SELECT last_insert_rowid() AS id').id
    }
    return { saved: true, contentHash: ch, baselineVersion: srcVer, edgeId }
  })
}

// ---------------------------------------------------------------- 锁

export function acquireLock(db, { docId, lang, actor, scope = 'language', section = null, ttl = 600 }) {
  const t = nowIso()
  const existing = db.get(
    'SELECT owner FROM doc_locks WHERE doc_id=$d AND lang=$l AND scope=$s AND COALESCE(section,\'\')=COALESCE($sec,\'\') AND expires_at>$t',
      { $d: docId, $l: lang, $s: scope, $sec: section, $t: t }
  )
  if (existing && existing.owner !== actor)
    throw new HttpError(423, 'lock-held', `锁由 ${existing.owner} 持有`, { owner: existing.owner })
  return db.tx(() => {
    db.run(
      `INSERT INTO doc_locks(doc_id,lang,owner,scope,section,expires_at)
       VALUES($d,$l,$o,$s,$sec,$e)
       ON CONFLICT(doc_id,lang,scope,section) DO UPDATE SET owner=$o, expires_at=$e, acquired_at=$t`,
      { $d: docId, $l: lang, $o: actor, $s: scope, $sec: section, $e: ttlIso(ttl), $t: t }
    )
    log(db, docId, 'lock', { lang, actor, scope, section })
    return { owner: actor, expiresAt: ttlIso(ttl) }
  })
}

export function releaseLock(db, { docId, lang, actor, scope = 'language', section = null }) {
  db.run(
    'DELETE FROM doc_locks WHERE doc_id=$d AND lang=$l AND scope=$s AND COALESCE(section,\'\')=COALESCE($sec,\'\') AND owner=$o',
    { $d: docId, $l: lang, $s: scope, $sec: section, $o: actor }
  )
  return { released: true }
}

/** 段落锁（TTL），用于两译者同时编辑同段 */
export function acquireSegmentLock(db, { docId, srcLang = 'zh', tgtLang = 'en', srcNid, tgtNid, actor, ttl = 120 }) {
  const t = nowIso()
  const held = db.get(
    `SELECT lock_owner AS owner FROM translations
     WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn AND lock_until>$t AND lock_owner IS NOT NULL`,
    { $d: docId, $sl: srcLang, $tl: tgtLang, $sn: srcNid, $t: t }
  )
  if (held && held.owner !== actor)
    throw new HttpError(423, 'segment-locked', `该段落正由 ${held.owner} 编辑`, { owner: held.owner })
  return db.tx(() => {
    db.run(
      `UPDATE translations SET lock_owner=$o, lock_until=$u
       WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn`,
      { $d: docId, $sl: srcLang, $tl: tgtLang, $sn: srcNid, $o: actor, $u: ttlIso(ttl) }
    )
    log(db, docId, 'lock', { srcNid, actor, scope: 'segment' })
    return { owner: actor, expiresAt: ttlIso(ttl) }
  })
}

// ---------------------------------------------------------------- 人工确认

export function decideEdge(db, { edgeId, decision, actor }) {
  if (!['confirmed', 'rejected'].includes(decision))
    throw new HttpError(400, 'bad-decision', 'decision 必须为 confirmed|rejected')
  const edge = db.get('SELECT * FROM alignment_edges WHERE id=$i', { $i: edgeId })
  if (!edge) throw new HttpError(404, 'edge-not-found', '对齐边不存在')
  return db.tx(() => {
    db.run(
      'UPDATE alignment_edges SET status=$s, reviewed_by=$a, conflict=NULL, updated_at=$t WHERE id=$i',
      { $s: decision, $a: actor, $t: nowIso(), $i: edgeId }
    )
    log(db, edge.doc_id, 'confirm-edge', { edgeId, decision, actor })
    return { edgeId, status: decision }
  })
}

/** 人工建立/覆盖一条对齐（来源缺失后的补救入口） */
export function manualPair(db, { docId, srcLang = 'zh', tgtLang = 'en', srcNid, tgtNid, actor }) {
  return db.tx(() => {
    db.run(
      `INSERT INTO alignment_edges(doc_id,src_lang,src_nid,tgt_lang,tgt_nid,rel,status,origin,created_by,reviewed_by)
       VALUES($d,$sl,$sn,$tl,$tn,'1:1','confirmed','manual',$a,$a)
       ON CONFLICT(doc_id,src_lang,src_nid,tgt_lang,tgt_nid)
       DO UPDATE SET status='confirmed', conflict=NULL, origin='manual', reviewed_by=$a, updated_at=$t`,
      {
        $d: docId,
        $sl: srcLang,
        $sn: srcNid,
        $tl: tgtLang,
        $tn: tgtNid,
        $a: actor,
        $t: nowIso()
      }
    )
    log(db, docId, 'confirm-edge', { srcNid, tgtNid, actor, manual: true })
    return { paired: true }
  })
}

// ---------------------------------------------------------------- 审阅流转

export function reviewTranslation(db, { docId, srcLang = 'zh', tgtLang = 'en', srcNid, tgtNid, status, reviewer }) {
  if (!['draft', 'in_review', 'verified'].includes(status))
    throw new HttpError(400, 'bad-status', '非法审阅状态')
  return db.tx(() => {
    const r = db.run(
      `UPDATE translations SET status=$s, reviewer=$r, updated_at=$t
       WHERE doc_id=$d AND src_lang=$sl AND tgt_lang=$tl AND src_nid=$sn AND tgt_nid=$tn`,
      {
        $s: status,
        $r: reviewer,
        $t: nowIso(),
        $d: docId,
        $sl: srcLang,
        $tl: tgtLang,
        $sn: srcNid,
        $tn: tgtNid
      }
    )
    log(db, docId, 'review', { srcNid, tgtNid, status, reviewer })
    return { reviewed: true, status }
  })
}

// ---------------------------------------------------------------- 搜索（可进历史版）

export function search(db, { q, lang = 'zh', docId = null, version = null }) {
  const like = `%${q}%`
  const rows = db.all(
    `SELECT s.doc_id AS docId, d.title AS docTitle, s.lang, s.version, s.nid, s.ord,
            s.kind, substr(replace(replace(s.content, char(10), ' '), '  ', ' '),1,160) AS snippet
     FROM segments s JOIN documents d ON d.id = s.doc_id
     WHERE s.lang=$l AND s.content LIKE $q
       AND ($d IS NULL OR s.doc_id=$d)
       AND ($v IS NULL OR s.version=$v)
       AND s.version = (SELECT current_ver FROM doc_langs dl WHERE dl.doc_id=s.doc_id AND dl.lang=s.lang)
     ORDER BY s.doc_id, s.ord LIMIT 50`,
    { $l: lang, $q: like, $d: docId, $v: version ?? null }
  )
  // 命中历史版：显式搜索版本参数时放宽 current 限制
  let hits = rows
  if (version) {
    hits = db.all(
      `SELECT s.doc_id AS docId, d.title AS docTitle, s.lang, s.version, s.nid, s.ord,
              s.kind, substr(replace(replace(s.content, char(10), ' '), '  ', ' '),1,160) AS snippet
       FROM segments s JOIN documents d ON d.id = s.doc_id
       WHERE s.lang=$l AND s.content LIKE $q AND ($d IS NULL OR s.doc_id=$d) AND s.version=$v
       ORDER BY s.doc_id, s.ord LIMIT 50`,
      { $l: lang, $q: like, $d: docId, $v: version }
    )
  }
  return { query: q, lang, version: version ?? 'current', hits }
}

export function versions(db, docId) {
  return db.all(
    'SELECT lang, version, hash, created_at AS createdAt FROM doc_versions WHERE doc_id=$d ORDER BY lang, version',
    { $d: docId }
  )
}

function log(db, docId, action, payload) {
  db.run('INSERT INTO review_log(doc_id,action,payload,actor) VALUES($d,$a,$p,$act)', {
    $d: docId,
    $a: action,
    $p: JSON.stringify(payload),
    $act: payload.actor ?? null
  })
}
