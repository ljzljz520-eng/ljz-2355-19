import { groupSha } from '../util/hash.js'
const now = () => Date.now()

const secKey = (n) => (n.section_path || 'root')

/**
 * 自动对齐（启发式，origin=auto，可被人工边覆盖）：
 *   1) 显式 node id 相同 -> 直接配对（章节重排也对得上）
 *   2) 代码块：两语言 content 都是同一 sha -> 配对（共享代码天然对齐）
 *   3) 同章节、同类型按出现顺序 1:1 配对（中文拆成两段英文的 1:N 留给人工边）
 * 已经存在有效边的节点不重复配对。
 */
export function autoAlign(db, docId, srcLang, tgtLang, { srcVersion, tgtVersion } = {}) {
  const sv = srcVersion ?? db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, srcLang).v
  const tv = tgtVersion ?? db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, tgtLang).v
  const src = db.prepare('SELECT * FROM nodes WHERE doc_id=? AND lang=? AND version_no=? ORDER BY ord').all(docId, srcLang, sv)
  const tgt = db.prepare('SELECT * FROM nodes WHERE doc_id=? AND lang=? AND version_no=? ORDER BY ord').all(docId, tgtLang, tv)

  // 当前版本对上已有效的边（auto + manual），避免重复配对、避免覆盖人工 1:N
  const claimed = new Set(db.prepare(`SELECT src_node_key, tgt_node_key FROM alignment_edges
    WHERE doc_id=? AND src_lang=? AND tgt_lang=? AND status='active' AND src_version=? AND tgt_version=?`)
    .all(docId, srcLang, tgtLang, sv, tv)
    .map((e) => `${e.src_node_key}>${e.tgt_node_key}`))
  const usedSrc = new Set(), usedTgt = new Set()
  for (const k of claimed) {
    const [s, t] = k.split('>'); usedSrc.add(s); usedTgt.add(t)
  }

  // auto 边按版本对独立保留：历史版查看历史对齐图；新版对齐不会删除旧版的边。
  // 旧版中已消失节点的「悬挂」由 buildGroups 按当前版本端点集合自然过滤。
  const pairs = []
  const pair = (s, t) => {
    if (usedSrc.has(s.node_key) || usedTgt.has(t.node_key)) return
    usedSrc.add(s.node_key); usedTgt.add(t.node_key)
    pairs.push([s.node_key, t.node_key])
  }

  // 1) 显式 id
  const tgtByExplicit = new Map(tgt.filter((t) => t.explicit_id).map((t) => [t.node_key, t]))
  for (const s of src.filter((n) => n.explicit_id)) {
    const t = tgtByExplicit.get(s.node_key)
    if (t) pair(s, t)
  }
  // 2) 代码 sha
  const tgtCodeBySha = new Map()
  for (const t of tgt.filter((n) => n.type === 'code')) {
    if (!tgtCodeBySha.has(t.content)) tgtCodeBySha.set(t.content, [])
    tgtCodeBySha.get(t.content).push(t)
  }
  const tgtShaUsed = new Set()
  for (const s of src.filter((n) => n.type === 'code')) {
    const arr = tgtCodeBySha.get(s.content) || []
    const t = arr.find((x) => !usedTgt.has(x.node_key) && !tgtShaUsed.has(x.node_key))
    if (t) { tgtShaUsed.add(t.node_key); pair(s, t) }
  }
  // 3) 同章节结构位置、同类型顺序
  const tgtGroups = new Map()
  for (const t of tgt) {
    if (t.type === 'code' || t.explicit_id) continue
    const k = `${secKey(t)}|${t.type}`
    if (!tgtGroups.has(k)) tgtGroups.set(k, [])
    tgtGroups.get(k).push(t)
  }
  for (const s of src) {
    if (s.type === 'code' || s.explicit_id || usedSrc.has(s.node_key)) continue
    const arr = tgtGroups.get(`${secKey(s)}|${s.type}`)
    if (!arr) continue
    const t = arr.find((x) => !usedTgt.has(x.node_key))
    if (t) pair(s, t)
  }

  const ins = db.prepare(`INSERT INTO alignment_edges
    (doc_id, src_lang, src_node_key, tgt_lang, tgt_node_key, src_version, tgt_version, origin, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'auto', 'active', ?, ?)
    ON CONFLICT(doc_id,src_lang,src_node_key,tgt_lang,tgt_node_key,origin,src_version,tgt_version)
    DO UPDATE SET status='active', updated_at=excluded.updated_at`)
  const tx = db.transaction(() => {
    for (const [s, t] of pairs) ins.run(docId, srcLang, s, tgtLang, t, sv, tv, now(), now())
  })
  tx()
  return { srcVersion: sv, tgtVersion: tv, pairs: pairs.length }
}

/**
 * 人工对齐：一个源节点集合 <-> 一个目标节点集合 的完整多对多（支持中文一段→英文多段）。
 * 覆盖范围内的 auto 边作废；若与已有人工组发生节点重叠，会产生 alignment_conflict 入审阅台。
 */
export function setManualAlignment(db, docId, srcLang, tgtLang, srcKeys, tgtKeys, actor = 'reviewer') {
  srcKeys = [...new Set(srcKeys)]; tgtKeys = [...new Set(tgtKeys)]
  if (!srcKeys.length || !tgtKeys.length) throw new Error('both srcKeys and tgtKeys are required')
  const sv = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, srcLang).v
  const tv = db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, tgtLang).v
  for (const k of srcKeys) if (!db.prepare('SELECT 1 FROM nodes WHERE doc_id=? AND lang=? AND version_no=? AND node_key=?').get(docId, srcLang, sv, k)) throw new Error(`source node not found: ${k}`)
  for (const k of tgtKeys) if (!db.prepare('SELECT 1 FROM nodes WHERE doc_id=? AND lang=? AND version_no=? AND node_key=?').get(docId, tgtLang, tv, k)) throw new Error(`target node not found: ${k}`)

  const dismissAuto = db.prepare(`UPDATE alignment_edges SET status='dismissed', updated_at=?
    WHERE doc_id=? AND src_lang=? AND tgt_lang=? AND status='active' AND origin='auto'
      AND src_version=? AND tgt_version=?
      AND (1=0 ${srcKeys.map(() => 'OR src_node_key=?').join(' ')} ${tgtKeys.map(() => 'OR tgt_node_key=?').join(' ')})`)
  const upManual = db.prepare(`INSERT INTO alignment_edges
    (doc_id, src_lang, src_node_key, tgt_lang, tgt_node_key, src_version, tgt_version, origin, status, created_at, updated_at)
    VALUES (?,?,?,?,?, 0, 0, 'manual', 'active', ?, ?)
    ON CONFLICT(doc_id,src_lang,src_node_key,tgt_lang,tgt_node_key,origin,src_version,tgt_version)
    DO UPDATE SET status='active', updated_at=excluded.updated_at`)

  // 检查与已有人工组重叠（人工边跨版本，按当前版本端点是否仍存在判断）-> conflict
  const existing = db.prepare(`SELECT src_node_key s, tgt_node_key t FROM alignment_edges
    WHERE doc_id=? AND src_lang=? AND tgt_lang=? AND status='active' AND origin='manual'
      AND (src_node_key IN (${srcKeys.map(() => '?').join(',')}) OR tgt_node_key IN (${tgtKeys.map(() => '?').join(',')}))`)
    .all(docId, srcLang, tgtLang, ...srcKeys, ...tgtKeys)
  const overlap = existing.some((e) => !srcKeys.includes(e.s) || !tgtKeys.includes(e.t))
  const openConflict = db.prepare(`SELECT 1 FROM review_queue WHERE doc_id=? AND kind='alignment_conflict' AND status='open' AND ref_key=?`)
  const addQueue = db.prepare(`INSERT INTO review_queue(doc_id, kind, ref_key, lang, detail_json, status, created_at)
    VALUES (?, 'alignment_conflict', ?, ?, ?, 'open', ?)`)

  const tx = db.transaction(() => {
    dismissAuto.run(now(), docId, srcLang, tgtLang, sv, tv, ...srcKeys, ...tgtKeys)
    for (const s of srcKeys) for (const t of tgtKeys) upManual.run(docId, srcLang, s, tgtLang, t, now(), now())
    if (overlap) {
      const refKey = `manual:${srcLang}:${srcKeys.join('+')}~${tgtLang}:${tgtKeys.join('+')}`
      if (!openConflict.get(docId, refKey)) {
        addQueue.run(docId, refKey, tgtLang, JSON.stringify({ srcKeys, tgtKeys, existing, actor, srcVersion: sv, tgtVersion: tv }), now())
      }
    }
  })
  tx()
  return { srcKeys, tgtKeys, edges: srcKeys.length * tgtKeys.length, overlapConflict: overlap }
}

/** 作废边（解绑后源/目标成为缺失侧，可再重映射） */
export function dismissEdge(db, docId, srcLang, srcKey, tgtLang, tgtKey) {
  db.prepare(`UPDATE alignment_edges SET status='dismissed', updated_at=?
    WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=? AND tgt_node_key=?`)
    .run(now(), docId, srcLang, srcKey, tgtLang, tgtKey)
  return { dismissed: db.prepare('SELECT changes() c').get().c }
}

/**
 * 构建对齐图：把有效边组成的二部图求连通分量（union-find），每个分量是一个「对齐组」。
 * 这是 1:N / N:1 / N:M 的统一表达，天然不依赖数组下标。
 *
 * 版本作用域：auto 边必须属于当前版本对；manual 边只要两端节点在当前版本仍存在
 * 即沿用（人工确认的对齐不应因发布新版本而丢失），但版本戳不同的会单独保留。
 */
export function buildGroups(db, docId, srcLang, tgtLang, srcVersion, tgtVersion) {
  const all = db.prepare(`SELECT * FROM alignment_edges
    WHERE doc_id=? AND src_lang=? AND tgt_lang=? AND status='active' ORDER BY edge_id`)
    .all(docId, srcLang, tgtLang)
  const srcKeys = new Set(db.prepare('SELECT node_key FROM nodes WHERE doc_id=? AND lang=? AND version_no=?')
    .all(docId, srcLang, srcVersion).map((r) => r.node_key))
  const tgtKeys = tgtVersion == null ? null : new Set(
    db.prepare('SELECT node_key FROM nodes WHERE doc_id=? AND lang=? AND version_no=?')
      .all(docId, tgtLang, tgtVersion).map((r) => r.node_key))
  const edges = all.filter((e) => {
    if (!srcKeys.has(e.src_node_key)) return false
    if (tgtKeys != null && !tgtKeys.has(e.tgt_node_key)) return false
    if (e.origin === 'manual') return true
    return e.src_version === srcVersion && e.tgt_version === tgtVersion
  })
  const parent = new Map()
  const find = (x) => { parent.has(x) || parent.set(x, x); return parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)) }
  const union = (a, b) => { parent.set(find(a), find(b)) }
  for (const e of edges) {
    const s = `s:${e.src_node_key}`, t = `t:${e.tgt_node_key}`
    find(s); find(t); union(s, t)
  }
  const groups = new Map()
  for (const e of edges) {
    const root = find(`s:${e.src_node_key}`)
    if (!groups.has(root)) groups.set(root, { src: new Set(), tgt: new Set(), origins: new Set() })
    const g = groups.get(root)
    g.src.add(e.src_node_key); g.tgt.add(e.tgt_node_key); g.origins.add(e.origin)
  }
  return [...groups.values()].map((g) => ({ src: [...g.src], tgt: [...g.tgt], origins: [...g.origins] }))
}

/** 当前版本下分组的源端内容 hash 清单 */
export function groupHashFor(db, docId, lang, versionNo, keys) {
  const nodes = db.prepare(`SELECT node_key, type, content_sha FROM nodes
    WHERE doc_id=? AND lang=? AND version_no=? AND node_key IN (${keys.map(() => '?').join(',')})`)
    .all(docId, lang, versionNo, ...keys)
  return groupSha(nodes)
}
