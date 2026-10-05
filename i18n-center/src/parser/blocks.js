/**
 * Markdown 语义块解析器
 *
 * 拆出「语义节点」：heading / paragraph / list_item / code。
 * 这是双语阅读的最小对齐单位——不是按行数组下标，所以中文一段拆成两段英文后，
 * 对齐仍可通过对齐图表达 1:N。
 *
 * 支持的指令（HTML 注释）：
 *   <!-- node:install-cmd -->   给下一个块显式、跨版本稳定的节点 id（章节重排也不丢）
 *   <!-- @i18n:shared -->       下一个块不翻译（正文里的代码/原样块），双栏共享
 */

const NODE_RE = /<!--\s*node:([\w.-]+)\s*-->/
const SHARED_RE = /<!--\s*@i18n:shared\s*-->|<!--\s*i18n:ignore\s*-->/

/** 抽取 inline code 与 {{不可翻译标记}}，替换为占位符，保持双栏引用一致 */
export function extractInline(raw) {
  const tokens = []
  let text = String(raw ?? '')
  const put = (kind, value) => {
    const placeholder = `⟦${tokens.length}⟧`
    tokens.push({ kind, value, placeholder })
    return placeholder
  }
  // 先抽 inline code（含反引号），避免其中的 {{ 被二次解析
  text = text.replace(/`+[^`\n]+?`+/g, (m) => put('code', m))
  // {{ 参数名 / 不可翻译文本 }}
  text = text.replace(/\{\{[^}\n]+\}\}/g, (m) => put('raw', m))
  return { text, tokens }
}

/** 占位符还原（前端也有一份同构实现；服务端用于返回 token 明细） */
export function renderSegments(text, tokens) {
  const segs = []
  const re = /⟦(\d+)⟧/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ type: 'text', value: text.slice(last, m.index) })
    const tok = tokens[Number(m[1])]
    segs.push({ type: tok.kind, value: tok.value })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ type: 'text', value: text.slice(last) })
  return segs
}

export function parseBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let headings = []          // { level, text, ord }：语言相关标题文本
  const depthCount = []      // 每个层级的标题序号（语言无关）
  let pendingNode = null
  let pendingShared = false
  let i = 0

  // 语言无关的章节结构路径：用标题层级序号（如 h0 / h0/h1），跨语言一致，
  // 这样「前置条件 / Prerequisites」是同一个结构位置，可用于跨语言对齐。
  const sectionPath = () => headings.map((h) => `h${h.ord}`).join('/') || 'root'

  const push = (b) => {
    const block = {
      explicitId: pendingNode,
      shared: pendingShared || b.type === 'code',
      headingPath: headings.map((h) => h.text).join(' > '),
      sectionPath: sectionPath(),
      ...b
    }
    blocks.push(block)
    pendingNode = null
    pendingShared = false
  }

  const setHeading = (level, text) => {
    while (headings.length && headings[headings.length - 1].level >= level) headings.pop()
    // 进入该层级时，更深层级的标题序号重置
    for (let l = level + 1; l < depthCount.length; l++) depthCount[l] = 0
    const ord = depthCount[level] ?? 0
    depthCount[level] = ord + 1
    headings.push({ level, text, ord })
  }

  while (i < lines.length) {
    let line = lines[i]

    if (!line.trim()) { i++; continue }

    // 行内前缀指令：`<!-- node:x -->正文` —— 取下指令，同一行继续解析正文
    let consumed = true
    while (consumed) {
      consumed = false
      const inlineNode = line.match(/^\s*<!--\s*node:([\w.-]+)\s*-->(.*)$/)
      if (inlineNode) { pendingNode = inlineNode[1]; line = inlineNode[2]; consumed = true }
      const inlineShared = line.match(/^\s*<!--\s*(?:@i18n:shared|i18n:ignore)\s*-->(.*)$/)
      if (inlineShared) { pendingShared = true; line = inlineShared[1]; consumed = true }
    }

    if (!line.trim()) { i++; continue }

    // 独占一行的指令注释
    const nm = line.trim().match(/^<!--\s*node:([\w.-]+)\s*-->$/)
    if (nm) { pendingNode = nm[1]; i++; continue }
    if (/^<!--\s*(?:@i18n:shared|i18n:ignore)\s*-->$/.test(line.trim())) { pendingShared = true; i++; continue }

    // 围栏代码块
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)\s*$/)
    if (fence) {
      const marker = fence[2][0]
      const len = fence[2].length
      const lang = fence[3] || ''
      const buf = []
      i++
      const endRe = new RegExp(`^\\s*${marker}{${len},}\\s*$`)
      while (i < lines.length && !endRe.test(lines[i])) {
        buf.push(lines[i]); i++
      }
      i++ // 跳过结束围栏
      push({ type: 'code', lang, code: buf.join('\n') })
      continue
    }

    // 标题
    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      const level = hm[1].length
      const { text, tokens } = extractInline(hm[2].trim())
      setHeading(level, text)
      push({ type: 'heading', level, text, rawText: hm[2].trim(), tokens })
      i++
      continue
    }

    // 列表项（连续的多个 item 各自成节点，支持中文一段对英文多个 item 的情况）
    const lim = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (lim) {
      const { text, tokens } = extractInline(lim[3].trim())
      push({ type: 'list_item', text, rawText: lim[3].trim(), tokens })
      i++
      continue
    }

    // 普通段落：聚合到空行
    const buf = [line]
    i++
    while (i < lines.length && lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^(\s*)(`{3}|~{3})/.test(lines[i]) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
      !NODE_RE.test(lines[i]) && !SHARED_RE.test(lines[i])) {
      buf.push(lines[i]); i++
    }
    const rawText = buf.join('\n').trim()
    const { text, tokens } = extractInline(rawText)
    push({ type: 'paragraph', text, rawText, tokens })
  }

  return blocks
}
