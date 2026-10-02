// 通用工具：规范化、哈希、受保护片段（参数名/不可翻译标记）提取与比对
import { createHash } from 'node:crypto'

/** 规范化：统一换行、去掉行尾空白、折叠多余空行（用于内容比较/哈希） */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function hash(text) {
  return createHash('sha1').update(normalize(text)).digest('hex')
}

/** 受保护片段（翻译时必须原样保留）：
 *  - 行内代码 `foo`（参数名、共享代码名、API 名）
 *  - [[keep:xxx]] 不可翻译标记
 *  - HTML 实体/标签内的属性引用不处理；这里只处理正文级
 */
const KEEP_RE = /\[\[keep:([^\]]+)\]\]/g
const CODE_RE = /`[^`\n]+`/g

export function protectedTokens(text) {
  const out = []
  const re = new RegExp(`${KEEP_RE.source}|${CODE_RE.source}`, 'g')
  let m
  while ((m = re.exec(text))) {
    out.push(m[1] ? m[1].trim() : m[0].slice(1, -1).trim())
  }
  return [...new Set(out)]
}

/** 校验译文是否保留了原文要求的全部受保护片段；返回缺失列表 */
export function missingProtected(sourceText, targetText) {
  const required = protectedTokens(sourceText)
  if (!required.length) return []
  const have = new Set(protectedTokens(targetText))
  return required.filter((t) => !have.has(t))
}

/** slug（标题自动 nid） */
export function slugify(text, lang) {
  const t = text
    .toLowerCase()
    .replace(/[`*_[\]()#.!?,，。！？：:、；;'"“”‘’]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return lang === 'zh' || /[一-鿿]/.test(t) ? `sec-${hash(text).slice(0, 8)}` : t
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** TTL 时间字符串 */
export function ttlIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

export function parseTagArgs(info) {
  // 形如 i18n:id=intro xref=intro,intro2 xref=keep-sec keep
  // xref 可重复或逗号分隔（合并翻译段 n:1）
  const args = {}
  for (const part of info.trim().split(/\s+/)) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      args[part] = true
      continue
    }
    const key = part.slice(0, eq)
    const val = part.slice(eq + 1)
    if (key === 'xref') args.xref = args.xref ? `${args.xref},${val}` : val
    else args[key] = val
  }
  return args
}
