import { parseBlocks } from '../parser/blocks.js'
import { contentSha, codeSha, normalize, sha1 } from '../util/hash.js'

const now = () => Date.now()
// 自动节点的章节段：语言无关的结构路径（h0/h1），跨语言/章节重排都稳定
const sectionSeg = (b) => (b.sectionPath || 'root')

/**
 * 为一个新版本的语义块分配跨版本稳定的 node_key：
 *   - 显式 <!-- node:id -->：直接用 id（章节重排也不丢身份）；
 *   - 自动节点：按「语言无关章节结构路径 + 类型 + 章节内序号」。
 *     结构路径只看标题层级位置，所以中文「前置条件」和英文「Prerequisites」同位置同 key；
 *     章节整体重排会移动标题，改的是它所在结构位置（审阅台会暴露来源变化），
 *     其它章节的节点身份不受影响。
 */
export function assignKeys(docId, blocks) {
  const seen = new Set()
  const counters = new Map()
  for (const b of blocks) {
    let key
    if (b.explicitId) {
      key = b.explicitId
    } else {
      const sec = sectionSeg(b)
      const ck = `${sec}::${b.type}`
      const ord = (counters.get(ck) ?? 0)
      counters.set(ck, ord + 1)
      key = `_auto_${sec.replace(/[^a-z0-9_]+/gi, '_')}__${b.type}_${ord}`
    }
    if (seen.has(key)) throw new Error(`duplicate node_key in ${docId}: ${key}`)
    seen.add(key)
    b.node_key = key
  }
  return blocks
}

/**
 * 发布（摄入）一个语言版本。幂等：重复发布同一版本号先删旧节点。
 * 不删除既有翻译单元——节点身份沿用稳定 key，原文改版后未变节点的 verified 状态保留。
 */
export function publishVersion(db, { docId, lang, versionNo, markdown, editor = 'system', note = '' }) {
  const blocks = assignKeys(docId, parseBlocks(markdown))

  const tx = db.transaction(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE doc_id=?').get(docId)
    if (!doc) throw new Error(`document not found: ${docId}`)

    db.prepare(`INSERT INTO document_versions(doc_id, lang, version_no, published_at, editor, note)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(doc_id,lang,version_no) DO UPDATE SET
                  published_at=excluded.published_at, editor=excluded.editor, note=excluded.note`)
      .run(docId, lang, versionNo, now(), editor, note)

    db.prepare('DELETE FROM nodes WHERE doc_id=? AND lang=? AND version_no=?').run(docId, lang, versionNo)

    const insCode = db.prepare(`INSERT OR IGNORE INTO code_snippets(sha, language, code, created_at) VALUES (?,?,?,?)`)
    const insNode = db.prepare(`INSERT INTO nodes
      (doc_id, lang, version_no, node_key, ord, type, heading_level, heading_path, section_path,
       content, raw_content, explicit_id, content_sha, tokens_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const getUnit = db.prepare(`SELECT * FROM translation_units
      WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=?`)
    const insUnit = db.prepare(`INSERT INTO translation_units
      (doc_id, src_lang, src_node_key, tgt_lang, status, updated_at)
      VALUES (?,?,?,?, 'untranslated', ?)`)
    const addHist = db.prepare(`INSERT INTO unit_history(doc_id, src_node_key, tgt_lang, action, actor, at)
      VALUES (?,?,?,?,?,?)`)

    blocks.forEach((b, ord) => {
      if (b.type === 'code') {
        const sha = codeSha(b.code)
        insCode.run(sha, b.lang || 'text', b.code, now())
        insNode.run(docId, lang, versionNo, b.node_key, ord, 'code', null, b.headingPath, b.sectionPath,
          sha, b.code, b.explicitId ? 1 : 0, sha, '[]')
      } else {
        const text = b.text
        insNode.run(docId, lang, versionNo, b.node_key, ord, b.type, b.level ?? null, b.headingPath, b.sectionPath,
          text, b.rawText ?? text, b.explicitId ? 1 : 0, contentSha(text), JSON.stringify(b.tokens ?? []))
      }
    })

    // 源语言发布：为其它已知语言补齐翻译单元（基线沿用，不重置状态）
    if (lang === doc.source_lang) {
      const langs = db.prepare('SELECT DISTINCT lang FROM document_versions WHERE doc_id=?').all(docId)
        .map((r) => r.lang).filter((l) => l !== lang)
      for (const b of blocks) {
        if (b.type === 'code') continue
        for (const tl of langs) {
          const ex = getUnit.get(docId, lang, b.node_key, tl)
          if (!ex) {
            insUnit.run(docId, lang, b.node_key, tl, now())
            addHist.run(docId, b.node_key, tl, 'unit_created', editor, now())
          }
        }
      }
    }
  })

  tx()
  return { docId, lang, versionNo, nodes: blocks.length }
}

/** 注册语言（为已存在的源节点批量补翻译单元），支持「某语言暂缺」后再补齐 */
export function registerTargetLanguage(db, docId, tgtLang) {
  return bootstrapUnits(db, docId, [tgtLang])
}

/** 为某文档的源节点按目标语言集合补齐翻译单元（已存在的不动，基线/状态延续） */
export function bootstrapUnits(db, docId, tgtLangs) {
  const doc = db.prepare('SELECT * FROM documents WHERE doc_id=?').get(docId)
  if (!doc) throw new Error(`document not found: ${docId}`)
  const srcVer = latestVersion(db, docId, doc.source_lang)
  if (srcVer == null) return { docId, units: 0 }
  const nodes = db.prepare(`SELECT * FROM nodes WHERE doc_id=? AND lang=? AND version_no=? AND type!='code'`)
    .all(docId, doc.source_lang, srcVer)
  const getUnit = db.prepare(`SELECT 1 FROM translation_units WHERE doc_id=? AND src_lang=? AND src_node_key=? AND tgt_lang=?`)
  const insUnit = db.prepare(`INSERT INTO translation_units
    (doc_id, src_lang, src_node_key, tgt_lang, status, updated_at) VALUES (?,?,?,?, 'untranslated', ?)`)
  const addHist = db.prepare(`INSERT INTO unit_history(doc_id, src_node_key, tgt_lang, action, actor, at)
    VALUES (?,?,?,?,?,?)`)
  const tx = db.transaction(() => {
    for (const n of nodes) {
      for (const tgtLang of tgtLangs) {
        if (!getUnit.get(docId, doc.source_lang, n.node_key, tgtLang)) {
          insUnit.run(docId, doc.source_lang, n.node_key, tgtLang, now())
          addHist.run(docId, n.node_key, tgtLang, 'language_registered', 'system', now())
        }
      }
    }
  })
  tx()
  return { docId, tgtLangs, units: nodes.length }
}

export function latestVersion(db, docId, lang) {
  return db.prepare(`SELECT MAX(version_no) v FROM document_versions WHERE doc_id=? AND lang=?`)
    .get(docId, lang).v
}

export function listVersions(db, docId) {
  return db.prepare(`SELECT lang, version_no, published_at, editor, note
    FROM document_versions WHERE doc_id=? ORDER BY lang, version_no`).all(docId)
}
