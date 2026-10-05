import crypto from 'node:crypto'

export const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex')

/**
 * 规范化：折叠空白，统一行尾。用于基线 hash —— 仅空白差异不算内容改动。
 */
export function normalize(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

/** 段落正文节点内容 hash（占位符保持原样，因此参数名/不可翻译标记的改动会改变 hash） */
export function contentSha(content) {
  return sha1(normalize(content))
}

/** 代码块：按规范化代码内容 hash，同码同 sha，天然共享 */
export function codeSha(code) {
  return sha1(normalize(code))
}

/**
 * 对齐分组 hash：一个翻译单元可能对应源端多个节点（N:1）。
 * 清单按 node_key 排序后哈希，源端任一节点内容改动都会改变 -> 相关译段转 stale。
 */
export function groupSha(nodes) {
  const manifest = nodes
    .map((n) => `${n.node_key}@${n.type}:${n.content_sha}`)
    .sort()
    .join('|')
  return sha1(manifest)
}

/** 排序后的 token 多重集签名：校验译文是否保留全部 inline code / {{标记}} */
export function tokenSig(tokens) {
  return tokens.map((t) => t.placeholder).sort().join('|')
}
