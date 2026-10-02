// 前端内核测试（jsdom 提供 DOM）：语义映射滚动 + Markdown 转义
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  globalThis.performance = dom.window.performance
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }
})

test('buildPairIndex：1:n / n:1 映射完整且与数组顺序无关', async () => {
  const { buildPairIndex } = await import('../../docs/.vitepress/theme/components/i18n/useSyncedScroll.js')
  const pairs = [
    { source: { nid: 's1' }, target: { nid: 't1' } },
    { source: { nid: 's1' }, target: { nid: 't2' } }, // 中文一段拆成两段英文
    { source: { nid: 's2' }, target: { nid: 't3' } },
    { source: { nid: 's3' }, target: { nid: 't3' } } // 两段中文合并为一段英文
  ]
  const { src2tgt, tgt2src } = buildPairIndex(pairs)
  assert.deepEqual(src2tgt.get('s1'), ['t1', 't2'])
  assert.deepEqual(tgt2src.get('t3'), ['s2', 's3'])
})

test('滚动内核：缺失目标列节点时不抛错；无对齐时走兜底', async () => {
  const { useSyncedScroll } = await import('../../docs/.vitepress/theme/components/i18n/useSyncedScroll.js')
  const index = { value: { src2tgt: new Map(), tgt2src: new Map() } }
  const ordered = { value: { src: [], tgt: [] } }
  const { bind, unbind } = useSyncedScroll(() => ({ left: null, right: null }), index, ordered)
  assert.doesNotThrow(() => bind(null, null))
  assert.doesNotThrow(() => unbind(null, null))
})

test('Markdown：先转义 HTML，再保留行内代码与 keep 标记', async () => {
  const { renderBlock } = await import('../../docs/.vitepress/theme/components/i18n/markdown.js')
  const html = renderBlock({ kind: 'paragraph', content: '调用 `createApp` 并保留 [[keep:X]] <script>x</script>' })
  assert.match(html, /<code class="bi-code">createApp<\/code>/)
  assert.match(html, /<mark class="bi-keep"/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>x<\/script>/)
})

test('代码块标记共享引用；codeRef 缺失时明确提示而不是渲染旧副本', async () => {
  const { renderBlock } = await import('../../docs/.vitepress/theme/components/i18n/markdown.js')
  const missing = renderBlock({ kind: 'code', codeRef: 'gone', code: { missing: true } })
  assert.match(missing, /codeRef gone 缺失/)
  const code = renderBlock({ kind: 'code', codeRef: 'c1', code: { content: 'npm i', langHint: 'bash' } })
  assert.match(code, /data-code-ref="c1"/)
  assert.match(code, /npm i/)
})
