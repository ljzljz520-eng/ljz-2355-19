// 段落级对齐图（alignment graph）——对比整篇语言锁的细粒度方案。
//
// 边的唯一依据：
//   1) 译文中显式的 xref（作者声明，可一对多：中文拆段、英文合并）；
//   2) code ref 同名（共享代码天然同语义，按引用而非下标）。
// 绝不做数组下标的隐式对齐；匹配不上的段落进入 unmatched，交人工确认入口处理。

export function pairMaps(edges) {
  const src2tgt = new Map()
  const tgt2src = new Map()
  for (const e of edges) {
    if (e.status === 'rejected') continue
    if (!src2tgt.has(e.srcNid)) src2tgt.set(e.srcNid, [])
    if (!tgt2src.has(e.tgtNid)) tgt2src.set(e.tgtNid, [])
    src2tgt.get(e.srcNid).push(e.tgtNid)
    tgt2src.get(e.tgtNid).push(e.srcNid)
  }
  return { src2tgt, tgt2src }
}

/**
 * @returns {{edges: Array, diagnostics: object}}
 */
export function buildGraph({ srcBlocks = [], tgtBlocks = [], existing = [], keepExisting = false } = {}) {
  const srcById = new Map(srcBlocks.map((b) => [b.nid, b]))
  const tgtById = new Map(tgtBlocks.map((b) => [b.nid, b]))
  const existingKey = new Map(existing.map((e) => [`${e.srcNid}->${e.tgtNid}`, e]))

  const declared = [] // {srcNid, tgtNid, origin, conflict}
  const missingSource = []
  const tgtDeclared = new Set()

  // 1) 显式 xref（一对多 / 多对一都用多条边表达）
  for (const tb of tgtBlocks) {
    for (const ref of tb.xrefs || []) {
      tgtDeclared.add(tb.nid)
      if (!srcById.has(ref)) {
        // 来源缺失：不丢弃，落为待人工处理的冲突边
        missingSource.push({ tgtNid: tb.nid, tgtKind: tb.kind, ref })
        declared.push({ srcNid: ref, tgtNid: tb.nid, origin: 'xref', conflict: 'missing-source' })
        continue
      }
      declared.push({ srcNid: ref, tgtNid: tb.nid, origin: 'xref', conflict: null })
    }
  }

  // 2) 共享代码引用（同名 code ref => 同语义；按引用对齐，不依赖下标）
  const srcCodeByName = new Map(
    srcBlocks.filter((b) => b.codeRef).map((b) => [b.codeRef, b.nid])
  )
  for (const tb of tgtBlocks) {
    if (tb.codeRef && srcCodeByName.has(tb.codeRef) && !tgtDeclared.has(tb.nid)) {
      declared.push({ srcNid: srcCodeByName.get(tb.codeRef), tgtNid: tb.nid, origin: 'code', conflict: null })
    }
  }

  const seen = new Set()
  const edges = []
  const pushEdge = (d, old) => {
    let status
    if (d.conflict === 'missing-source') status = old?.status && old.status !== 'rejected' ? old.status : 'proposed'
    else if (old?.status === 'rejected') status = 'proposed' // 被否决后作者重新声明：重新进入人工确认
    else status = old?.status || 'confirmed'
    edges.push({
      srcNid: d.srcNid,
      tgtNid: d.tgtNid,
      origin: d.origin,
      status,
      conflict: d.conflict,
      ...(old?.id != null ? { id: old.id } : {}),
      ...(old?.reviewedBy ? { reviewedBy: old.reviewedBy } : {})
    })
  }
  for (const d of declared) {
    const key = `${d.srcNid}->${d.tgtNid}`
    if (seen.has(key)) continue
    seen.add(key)
    pushEdge(d, existingKey.get(key))
  }

  // 保留人工确认/既有的历史边（节点仍存在）：来源缺失补救、历史裁决不被重新解析冲掉
  if (keepExisting) {
    for (const old of existing) {
      if (old.status === 'rejected' || old.conflict === 'orphaned') continue
      const key = `${old.srcNid}->${old.tgtNid}`
      if (seen.has(key)) continue
      if (!tgtById.has(old.tgtNid)) continue // 译文节点已消失：交由 orphaned 诊断
      const d = srcById.has(old.srcNid)
        ? { srcNid: old.srcNid, tgtNid: old.tgtNid, origin: old.origin || 'manual', conflict: null }
        : { srcNid: old.srcNid, tgtNid: old.tgtNid, origin: old.origin || 'manual', conflict: 'missing-source' }
      seen.add(key)
      pushEdge(d, old)
    }
  }

  const { src2tgt, tgt2src } = pairMaps(edges)

  // 3) 关系基数
  for (const e of edges) {
    const nTgt = src2tgt.get(e.srcNid)?.length || 0
    const nSrc = tgt2src.get(e.tgtNid)?.length || 0
    e.rel = nTgt > 1 ? '1:n' : nSrc > 1 ? 'n:1' : '1:1'
  }

  // 4) 对齐冲突：拆段(1:n)与合并(n:1)在同一张图中交叉 => 归属歧义，需人工确认
  const ambiguousKeys = new Set()
  for (const e of edges) {
    const tgtMerged = (tgt2src.get(e.tgtNid)?.length || 0) > 1
    const srcSplit = (src2tgt.get(e.srcNid)?.length || 0) > 1
    if (tgtMerged && srcSplit) ambiguousKeys.add(`${e.srcNid}->${e.tgtNid}`)
  }
  const ambiguous = []
  for (const e of edges) {
    if (ambiguousKeys.has(`${e.srcNid}->${e.tgtNid}`)) {
      e.conflict = 'ambiguous'
      ambiguous.push({ srcNid: e.srcNid, tgtNid: e.tgtNid })
    }
  }

  const matchedSrc = new Set([...src2tgt.keys()].filter((n) => srcById.has(n)))
  const matchedTgt = new Set([...tgt2src.keys()])
  const unmatchedSrc = srcBlocks
    .filter((b) => !matchedSrc.has(b.nid))
    .map((b) => ({ srcNid: b.nid, kind: b.kind }))
  const unmatchedTgt = tgtBlocks
    .filter((b) => !matchedTgt.has(b.nid))
    .map((b) => ({ tgtNid: b.nid, kind: b.kind }))

  return {
    edges: edges.filter((e) => e.status !== 'rejected').map((e) => ({ ...e })),
    diagnostics: { missingSource, ambiguous, unmatchedSrc, unmatchedTgt }
  }
}

/** 滚动/语义定位：按对齐映射找节点；无对齐返回 null，由调用方按最近 ord 兜底 */
export function semanticPosition(nid, map, orderedNids) {
  if (map.has(nid)) return { nid: map.get(nid)[0], aligned: true }
  if (!orderedNids?.length) return { nid: null, aligned: false }
  return { nid: orderedNids[0], aligned: false }
}
