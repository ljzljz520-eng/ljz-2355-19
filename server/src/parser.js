// Markdown -> 语义节点块序列。
// 关键：节点身份来自显式 `<!-- i18n:id=... -->` 标记（或标题 slug），
// 翻译侧用 `<!-- i18n:xref=... -->` 表达对应关系；绝不按数组下标对齐。
//
// 支持的标记（单独一行的 HTML 注释，可合并写）：
//   <!-- i18n:id=intro -->                 原文/译文自定义稳定节点 ID
//   <!-- i18n:xref=intro,intro-2 -->       译文指向一个或多个原文节点（一对多/合并）
//   <!-- i18n:code=install-npm lang=bash --> 紧随代码块：共享代码引用，正文不复制
//
import { hash, normalize, slugify, parseTagArgs } from './util.js'

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*#*\s*$/
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/
const QUOTE_RE = /^\s*>/
const TABLE_RE = /^\s*\|.*\|\s*$/
const I18N_RE = /^\s*<!--\s*i18n:(.*?)-->\s*$/
const FRONTMATTER_BOUND = /^---\s*$/

function classify(line) {
  if (HEADING_RE.test(line)) return 'heading'
  if (FENCE_RE.test(line)) return 'fence-open'
  if (LIST_RE.test(line)) return 'list'
  if (TABLE_RE.test(line)) return 'table'
  if (QUOTE_RE.test(line)) return 'quote'
  // 普通 HTML 注释是 html 块；i18n: 注释在主循环中已先行截获，不会走到这里
  if (/^\s*<(?!!--)/.test(line)) return 'html'
  if (/^\s*<!--(?!.*i18n:)/.test(line)) return 'html'
  if (/^\s*$/.test(line)) return 'blank'
  return 'paragraph'
}

/**
 * @param {string} raw  markdown 原文
 * @param {string} lang 语言码 zh|en
 * @returns {{blocks: Array, codeRefs: Array<{name, langHint, content}>}}
 */
export function parseDocument(raw, lang) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  const inlineCodeRefs = []
  let pending = null // 待作用于下一块的 i18n 标记参数
  let i = 0

  // 跳过 frontmatter
  if (FRONTMATTER_BOUND.test(lines[0] ?? '')) {
    i = 1
    while (i < lines.length && !FRONTMATTER_BOUND.test(lines[i])) i++
    i++
  }

  const flush = (kind, contentLines, extra = {}) => {
    const content = normalize(contentLines.join('\n'))
    if (!content && !extra.codeRef) return // 空块（允许空代码引用占位）
    const ord = blocks.length
    let nid = pending?.id
    let nidAuto = 0
    if (!nid) {
      if (kind === 'heading') nid = slugify(extra.headingText || content, lang)
      else nid = `auto-${lang}-${ord}-${hash(content).slice(0, 8)}`
      nidAuto = 1
    }
    blocks.push({
      nid,
      nidAuto,
      ord,
      kind,
      content,
      hash: hash(content),
      xrefs: pending?.xref ? String(pending.xref).split(',').map((s) => s.trim()).filter(Boolean) : [],
      codeRef: pending?.code || extra.codeRef || null,
      langHint: pending?.lang || extra.langHint || null,
      level: extra.level ?? null,
      headingText: extra.headingText ?? null,
      ...extra
    })
    pending = null
  }

  while (i < lines.length) {
    const line = lines[i]
    const tag = line.match(I18N_RE)
    if (tag) {
      pending = { ...(pending || {}), ...parseTagArgs(tag[1]) }
      i++
      continue
    }

    const kind = classify(line)

    if (kind === 'blank') {
      // i18n 标记必须紧贴目标块；出现空行即视为无目标的独立注释，放弃 pending
      pending = null
      i++
      continue
    }

    if (kind === 'heading') {
      const m = line.match(HEADING_RE)
      flush('heading', [m[2]], { level: m[1].length, headingText: m[2].replace(/[`*]/g, '') })
      i++
      continue
    }

    if (kind === 'fence-open') {
      const m = line.match(FENCE_RE)
      const fence = m[2][0].repeat(3)
      const langHint = m[3] || null
      const body = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
        body.push(lines[i])
        i++
      }
      i++ // 跳过闭合围栏
      const codeName = pending?.code || null
      if (codeName) {
        inlineCodeRefs.push({ name: codeName, langHint: pending?.lang || langHint, content: normalize(body.join('\n')) })
      }
      flush('code', body, { codeRef: codeName, langHint })
      continue
    }

    // 分组类型：连续同类行合并为一个语义节点
    const groupKinds = ['list', 'table', 'quote', 'html', 'paragraph']
    const buf = [line]
    i++
    while (i < lines.length) {
      const k2 = classify(lines[i])
      if (k2 === 'blank') {
        // 表格/列表内部允许单个空行；这里保守断块
        break
      }
      if (groupKinds.includes(k2) && k2 === kind) {
        buf.push(lines[i])
        i++
      } else break
    }
    flush(kind, buf)
  }

  return { blocks, codeRefs: inlineCodeRefs }
}
