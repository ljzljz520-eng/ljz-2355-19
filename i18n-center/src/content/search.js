/**
 * 语义搜索：在节点正文（raw_content）上做包含匹配。
 * 关键：命中结果带 (doc, lang, version_no, node_key)，点进去即钉住该历史版本
 * 并定位到语义节点 —— 不是滚动到像素位置，所以换版/重排后仍能落在同一语义处。
 */
export function search(db, { q, lang, doc, limit = 20 }) {
  const terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { q, hits: [] }
  // 多词 AND
  const conds = terms.map(() => 'lower(n.raw_content) LIKE ?')
  const params = []
  const sql = `
    SELECT n.doc_id, d.slug, d.title, d.source_lang, n.lang, n.version_no, n.node_key,
           n.type, n.heading_path, n.ord, n.raw_content,
           dv.published_at, dv.editor
    FROM nodes n JOIN documents d ON d.doc_id=n.doc_id
    JOIN document_versions dv ON dv.doc_id=n.doc_id AND dv.lang=n.lang AND dv.version_no=n.version_no
    WHERE ${conds.join(' AND ')}
      ${lang ? 'AND n.lang=?' : ''}
      ${doc ? 'AND (n.doc_id=? OR d.slug=?)' : ''}
    ORDER BY n.doc_id, n.lang, n.version_no DESC, n.ord
    LIMIT ?`
  for (const t of terms) params.push(`%${t}%`)
  if (lang) params.push(lang)
  if (doc) params.push(doc, doc)
  params.push(limit)

  const rows = db.prepare(sql).all(...params)
  const verOf = (docId, lang) => db.prepare('SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?').get(docId, lang).v
  return {
    q,
    hits: rows.map((r) => {
      const latest = verOf(r.doc_id, r.lang)
      return {
        doc: r.slug, title: r.title, source_lang: r.source_lang,
        lang: r.lang, version: r.version_no, is_latest: r.version_no === latest,
        node_key: r.node_key, type: r.type, heading_path: r.heading_path,
        snippet: makeSnippet(r.raw_content, terms),
        // 进入历史版的定位链接（服务端拼好，前端直接用）
        href: buildHref(r, latest)
      }
    })
  }
}

/**
 * 进入阅读器的链接：
 *  - 命中源语言节点：钉源版本 srcV（左栏原文历史版，右栏对应/最新译文）
 *  - 命中译文节点：钉目标版本 tgtV + 源版本取与基线一致的最新版，定位 node
 * 任一钉版本都会触发 pinned_history 横幅，明确「基于哪版原文」。
 */
function buildHref(r, latest) {
  const params = new URLSearchParams()
  params.set('doc', r.slug)
  if (r.lang === r.source_lang) {
    params.set('srcV', r.version_no)
  } else {
    params.set('tgt', r.lang)
    params.set('tgtV', r.version_no)
  }
  params.set('node', r.node_key)
  return `/?${params.toString()}`
}

function makeSnippet(text, terms) {
  const low = text.toLowerCase()
  const i = Math.max(0, ...terms.map((t) => low.indexOf(t)).filter((x) => x >= 0))
  const start = Math.max(0, i - 24)
  const end = Math.min(text.length, i + 60)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')
}
