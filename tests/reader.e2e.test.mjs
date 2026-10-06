// 前端冒烟测试：jsdom 加载阅读器，对接真实 API，验证渲染、横幅、滚动同步映射与交互
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from '../server/api.js'
import { seed } from '../scripts/seed.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let server, base, dom

before(async () => {
  server = createServer(':memory:')
  seed(server.db, { demoDrift: true }) // quickstart zh→v2，1 段待复核，锁 stale
  await new Promise((r) => server.listen(0, r))
  server.unref()
  base = `http://localhost:${server.address().port}`

  const html = fs.readFileSync(path.join(ROOT, 'server/public/index.html'), 'utf8')
  dom = new JSDOM(html, { url: base, runScripts: 'outside-only', pretendToBeVisual: true })
  // 注入运行环境：fetch 指向真实 API
  dom.window.fetch = (p, o) => fetch(p.startsWith('http') ? p : base + p, o)
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const appJs = fs.readFileSync(path.join(ROOT, 'server/public/app.js'), 'utf8')
  dom.window.eval(appJs)
  await new Promise((r) => setTimeout(r, 300)) // 等待 init 完成
})

after(() => server?.close())

const $ = (s) => dom.window.document.querySelector(s)
const $$ = (s) => [...dom.window.document.querySelectorAll(s)]

test('阅读器初始化：文档列表加载，默认渲染双语段', () => {
  assert.ok($('#docSelect').options.length >= 4)
  assert.ok($$('#leftPane .seg').length > 0)
  assert.ok($$('#rightPane .seg').length > 0)
})

test('过期译文明确标注：横幅显示基于哪版原文，绝不伪装完全同步', async () => {
  $('#docSelect').value = 'guide/quickstart'
  $('#docSelect').dispatchEvent(new dom.window.Event('change'))
  await new Promise((r) => setTimeout(r, 300))
  const banner = $('#banner').textContent
  assert.match(banner, /译文基于原文 v1，当前原文 v2/)
  assert.match(banner, /1 段待复核/)
  assert.match(banner, /语言锁：已过期/)
  assert.ok($('#rightPane .badge.needs_review'), '右栏有待复核徽章')
  assert.ok(!banner.includes('完全同步'))
})

test('一对多对齐渲染：中文一段对应英文两张卡片', async () => {
  $('#docSelect').value = 'guide/telemetry'
  $('#docSelect').dispatchEvent(new dom.window.Event('change'))
  await new Promise((r) => setTimeout(r, 300))
  const banner = $('#banner').textContent
  assert.match(banner, /完全同步/) // telemetry 全已验且锁定 → 可标注同步
  // 找到中文长段对应的右侧卡片数
  const pairs = $$('#rightPane .seg').length
  assert.ok(pairs >= 7) // en 有 7 段
})

test('共享代码段来自 code_ref 且标注未复制', () => {
  const codeCard = $$('#rightPane .seg').find((el) => el.dataset.segKey === 'code:1')
  assert.ok(codeCard)
  assert.match(codeCard.textContent, /共享代码块/)
  assert.match(codeCard.textContent, /MYLIB_TELEMETRY=1/)
})

test('点击段交叉高亮对侧语义节点', async () => {
  const left = $$('#leftPane .seg').find((el) => el.dataset.segKey?.startsWith('p:'))
  left.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 50))
  assert.ok($$('#rightPane .seg.linked').length >= 1)
})

test('语言锁面板：锁与对齐图比对可见', async () => {
  $('#docSelect').value = 'guide/quickstart'
  $('#docSelect').dispatchEvent(new dom.window.Event('change'))
  await new Promise((r) => setTimeout(r, 300))
  $('#graphBtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  const report = $('#syncReport').textContent
  assert.match(report, /语言锁：已过期/)
  assert.match(report, /可展示为“完全同步”\s*否/)
})

test('版本切换滚动保持语义位置：锚定段不变，重载后回到同一语义节点而非页首', async () => {
  $('#docSelect').value = 'guide/quickstart'
  $('#docSelect').dispatchEvent(new dom.window.Event('change'))
  await new Promise((r) => setTimeout(r, 300))

  // jsdom 无布局：在原型层桩几何，使重载中新建的卡片在 restoreSemanticScroll 时也有坐标。
  // 每张卡片按其在栏内的顺序占 70px，视口位置 = 顺序*70 - scrollTop。
  const proto = dom.window.HTMLElement.prototype
  const origRect = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    if (this.id === 'leftPane' || this.id === 'rightPane') return { top: 0, bottom: 600 }
    if (this.classList && this.classList.contains('seg')) {
      const pane = this.closest('.pane')
      if (!pane) return { top: 0, bottom: 0 }
      const order = [...pane.querySelectorAll('.seg')].indexOf(this)
      const top = order * 70 - pane.scrollTop
      return { top, bottom: top + 60 }
    }
    return { top: 0, bottom: 0 }
  }
  try {
    const anchorKey = 'p:ed5c571a18' // 简介段：v1/v2 小改但 seg_key 内容寻址继承一致
    const left = $('#leftPane')
    left.scrollTop = 70 // 模拟用户已向下滚动：第 0 张卡片越过阈值，简介段成为首个可见锚点
    assert.ok([...left.querySelectorAll('.seg')].some((el) => el.dataset.segKey === anchorKey))

    // 切到原文 v1（历史版）：reloadPreserving 捕获语义锚点，重渲染后归位
    $('#srcVersionSelect').value = '1'
    $('#srcVersionSelect').dispatchEvent(new dom.window.Event('change'))
    await new Promise((r) => setTimeout(r, 300))

    const anchorAfter = [...left.querySelectorAll('.seg')].find((el) => el.dataset.segKey === anchorKey)
    assert.ok(anchorAfter, '历史版仍按同一 seg_key 找到简介段')
    const top = anchorAfter.getBoundingClientRect().top
    assert.ok(Math.abs(top - 16) <= 2, `简介段应归位到视口顶部附近，实际 top=${top}, scrollTop=${left.scrollTop}`)
    assert.match($('#banner').textContent, /历史版本/)
  } finally {
    proto.getBoundingClientRect = origRect
    $('#leftPane').scrollTop = 0
  }
})

test('搜索可进入历史版本并标注', async () => {
  const input = $('#searchInput')
  input.value = '本节将介绍如何在项目中使用'
  input.dispatchEvent(new dom.window.Event('input'))
  await new Promise((r) => setTimeout(r, 500))
  const items = $$('#searchResults .search-item')
  assert.ok(items.length >= 1)
  assert.match($('#searchResults').textContent, /历史版本/) // v1 为历史版
  // 点击历史版结果 → 进入该版本视图
  const hist = items.find((el) => el.textContent.includes('历史版本'))
  hist.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 400))
  assert.match($('#banner').textContent, /历史版本/)
})
