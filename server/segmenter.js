// Markdown → 语义节点切分。每个块获得稳定 seg_key（跨版本继承，不依赖数组下标）。
import crypto from 'node:crypto'

export const hash = (s) => crypto.createHash('sha1').update(s ?? '').digest('hex').slice(0, 10)

export function slug(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, '-').replace(/[`'"<>]/g, '').slice(0, 60)
}

/** 把 markdown 切成语义块：heading / paragraph / code（代码块语言无关，带 ordinal） */
export function segmentMarkdown(md) {
  const lines = String(md).split('\n')
  const blocks = []
  let i = 0, codeIdx = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const buf = [line]; i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      if (i < lines.length) { buf.push(lines[i]); i++ }
      codeIdx++
      blocks.push({ type: 'code', content: buf.join('\n'), ordinal: codeIdx })
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { blocks.push({ type: 'heading', level: h[1].length, content: h[2].trim() }); i++; continue }
    if (line.trim() === '') { i++; continue }
    const buf = [line]; i++
    while (i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i]) && !/^```/.test(lines[i])) {
      buf.push(lines[i]); i++
    }
    blocks.push({ type: 'paragraph', content: buf.join('\n').trim() })
  }
  return blocks
}

/** 提取不可翻译标记：行内代码、参数名（译文必须保留，保持引用一致） */
export function untranslatableTokens(text) {
  const tokens = new Set()
  for (const m of String(text).matchAll(/`([^`]+)`/g)) tokens.add(m[1])
  return [...tokens]
}

/** 校验译文是否保留了原文的不可翻译标记，返回缺失列表 */
export function checkUntranslatable(srcContent, tgtContent) {
  return untranslatableTokens(srcContent).filter((t) => !String(tgtContent).includes(t))
}

// ---- 版本间 seg_key 继承：内容寻址 + 相似度，而非位置下标 ----

function bigrams(s) {
  const t = String(s).replace(/\s+/g, ' ')
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

export function similarity(a, b) {
  if (a === b) return 1
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/**
 * 为新版本块分配 seg_key：
 * 1) 调用方显式指定的 key 优先（编辑器/种子保留的语义 id）
 * 2) 与上一版本内容哈希精确匹配 → 继承（重排、移动后仍稳定）
 * 3) 与上一版本高相似（≥0.6）→ 继承（原文小改仍识别为同一节点）
 * 4) 否则分配新 key
 */
export function assignKeys(blocks, prevSegments) {
  const usedPrev = new Set()
  const usedKeys = new Set()
  for (const b of blocks) if (b.key) usedKeys.add(b.key)

  // 2. 精确匹配
  for (const b of blocks) {
    if (b.key) continue
    const h = hash(b.type === 'code' ? '' : b.content)
    const hit = prevSegments.find(
      (s) => !usedPrev.has(s.seg_key) && !usedKeys.has(s.seg_key) &&
             s.seg_type === b.type && s.content_hash === h
    )
    if (hit) { b.key = hit.seg_key; usedPrev.add(hit.seg_key); usedKeys.add(b.key) }
  }
  // 3. 相似度匹配（一对一贪心）
  for (const b of blocks) {
    if (b.key || b.type === 'code') continue
    let best = null, bestScore = 0.6
    for (const s of prevSegments) {
      if (usedPrev.has(s.seg_key) || usedKeys.has(s.seg_key) || s.seg_type !== b.type) continue
      const sc = similarity(s.content, b.content)
      if (sc > bestScore) { best = s; bestScore = sc }
    }
    if (best) { b.key = best.seg_key; usedPrev.add(best.seg_key); usedKeys.add(b.key) }
  }
  // 4. 新 key
  for (const b of blocks) {
    if (b.key) continue
    const base = b.type === 'heading' ? `h:${slug(b.content)}`
      : b.type === 'code' ? `code:${b.ordinal ?? hash(b.content)}`
      : `p:${hash(b.content)}`
    let k = base, n = 2
    while (usedKeys.has(k)) k = `${base}#${n++}`
    b.key = k; usedKeys.add(k)
  }
  return blocks
}
