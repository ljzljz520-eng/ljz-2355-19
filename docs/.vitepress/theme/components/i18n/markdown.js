// 极小 Markdown 渲染器（数据来自受信内容 API，但仍先转义 HTML）。
// 重点保留：行内代码（参数名/共享引用）、[[keep:X]] 标记、链接、粗体；
// 代码块节点由 BilingualReader 单独渲染（共享 codeRef 的内容只引用一份）。

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(s) {
  let out = esc(s)
  // keep 标记高亮（不可翻译引用）
  out = out.replace(/\[\[keep:([^\]]+)\]\]/g, '<mark class="bi-keep" title="不可翻译标记">$1</mark>')
  // 行内代码（参数名、API 名保持引用一致）
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code class="bi-code">${c}</code>`)
  // 粗体
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 链接
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => {
    const safe = /^https?:|^#|^\//.test(href) ? esc(href) : '#'
    return `<a href="${safe}">${t}</a>`
  })
  return out
}

export function renderBlock(node) {
  const c = node.content || ''
  switch (node.kind) {
    case 'heading':
      return `<h${node.level} class="bi-h bi-h${node.level}">${inline(c)}</h${node.level}>`
    case 'list': {
      const items = c
        .split('\n')
        .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
        .filter(Boolean)
      const ordered = /^\s*\d+[.)]/.test(c)
      const tag = ordered ? 'ol' : 'ul'
      return `<${tag} class="bi-list">${items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`
    }
    case 'table': {
      const lines = c.split('\n').filter(Boolean)
      const parseRow = (l) => l.replace(/^\||\|$/g, '').split('|').map((x) => x.trim())
      const head = parseRow(lines[0] || '')
      const body = lines.slice(2).map(parseRow)
      return `<table class="bi-table"><thead><tr>${head
        .map((h) => `<th>${inline(h)}</th>`)
        .join('')}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    }
    case 'quote':
      return `<blockquote class="bi-quote">${c
        .split('\n')
        .map((l) => inline(l.replace(/^\s*>\s?/, '')))
        .join('<br>')}</blockquote>`
    case 'code':
      return renderCode(node)
    default:
      return c
        .split(/\n{2,}/)
        .map((p) => `<p class="bi-p">${p.split('\n').map(inline).join('<br>')}</p>`)
        .join('')
  }
}

export function renderCode(node) {
  const code = node.code || {}
  if (code.missing) {
    return `<pre class="bi-codeblock bi-code-missing"><code>⚠ codeRef ${esc(node.codeRef)} 缺失</code></pre>`
  }
  const text = code.content ?? node.content ?? ''
  return `<pre class="bi-codeblock" data-code-ref="${esc(node.codeRef || '')}"><span class="bi-code-lang">${esc(
    code.langHint || node.langHint || ''
  )}</span><code>${esc(text)}</code></pre>`
}
