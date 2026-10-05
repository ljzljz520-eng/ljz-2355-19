import { mapScroll } from './scroll-map.js'
// ============ 工具 ============
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const api = async (path, opts) => {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), data)
  return data
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const STATUS_LABEL = {
  verified: '已验收', stale: '原文已改·待复核', in_review: '待复核', draft: '草稿',
  untranslated: '未翻译', missing: '译文缺失', source_missing: '来源缺失', conflict: '对齐/编辑冲突',
  code_synced: '代码一致', code_outdated: '代码已更新', code_unaligned: '代码未对齐'
}
const TYPE_LABEL = { heading: '标题', paragraph: '段落', list_item: '列表项', code: '代码' }

// ============ 状态 ============
const state = {
  docs: [], doc: null, tgt: 'en', mode: 'graph',
  srcV: undefined, tgtV: undefined, reader: null,
  activeNode: null, anchorNode: null
}

// ============ Markdown 轻渲染（占位符 → inline code/raw 标记） ============
function renderInline(raw, tokens) {
  // 优先用服务端 token 列表，保证占位符与 token 一致
  const byPh = new Map((tokens || []).map((t) => [t.placeholder, t]))
  const text = tokens && tokens.length ? restoreTokens(raw, tokens) : raw
  let html = esc(text)
  html = html.replace(/`+([^`\n]+?)`+/g, (m, c) => `<span class="tok-code">${esc(c)}</span>`)
  html = html.replace(/\{\{([^}\n]+)\}\}/g, (m, c) => `<span class="tok-raw" title="不可翻译标记">{{${esc(c)}}}</span>`)
  return html
}
function restoreTokens(text, tokens) {
  // raw_content 里没有占位符（占位只在 content），这里直接返回 raw
  return text
}

// ============ 初始化文档列表 ============
async function loadDocs() {
  const { documents } = await api('/api/documents')
  state.docs = documents
  $('#docSel').innerHTML = documents.map((d) => `<option value="${d.slug}">${esc(d.title)} (${d.slug})</option>`).join('')
  if (!state.doc || !documents.find((d) => d.slug === state.doc)) state.doc = documents[0]?.slug
  $('#docSel').value = state.doc
}

function versionOptions(docSlug, lang, selected) {
  const d = state.docs.find((x) => x.slug === docSlug)
  if (!d) return ''
  const vs = d.versions.filter((v) => v.lang === lang).map((v) => v.version_no)
  return vs.map((v) => `<option value="${v}" ${String(v) === String(selected) ? 'selected' : ''}>v${v}</option>`).join('')
}

async function loadReader() {
  const params = new URLSearchParams()
  params.set('doc', state.doc)
  params.set('tgt', state.tgt)
  params.set('mode', state.mode)
  if (state.srcV != null) params.set('srcV', state.srcV)
  if (state.tgtV != null) params.set('tgtV', state.tgtV)
  state.reader = await api(`/api/reader?${params}`)
  primeCodeCache(state.reader)
  render()
}

// ============ 渲染 ============
function render() {
  const r = state.reader
  $('#srcTitle').textContent = `原文 · ${r.languages.source}`
  $('#tgtTitle').textContent = `译文 · ${r.languages.target}`
  $('#srcVer').textContent = `v${r.versions.source} / 最新 v${r.versions.source_latest}`
  $('#tgtVer').textContent = r.languages.target_available ? `v${r.versions.target} / 最新 v${r.versions.target_latest ?? '—'}` : '（该语言暂缺）'

  renderBanner(r)
  renderVersionSelectors(r)
  renderLockButton(r)
  renderBody(r)
  renderReviewBadge(r)
  setupScrollSync()
  if (state.anchorNode) scrollToNode(state.anchorNode, true)
  history.replaceState(null, '', location.pathname + '?' + readerQuery(r))
}

function readerQuery(r) {
  const p = new URLSearchParams()
  p.set('doc', state.doc); p.set('tgt', state.tgt); p.set('mode', state.mode)
  if (state.srcV != null) p.set('srcV', state.srcV)
  if (state.tgtV != null) p.set('tgtV', state.tgtV)
  if (state.activeNode) p.set('node', state.activeNode)
  return p.toString()
}

function renderBanner(r) {
  const icon = { success: '✅', warning: '⚠️', info: 'ℹ️' }[r.banner.level] || 'ℹ️'
  let extra = ''
  if (!r.fully_synced.value && r.banner.key !== 'lang_missing') {
    extra = ` <span class="tag" style="margin-left:8px">不能宣称完全同步：${esc(r.fully_synced.reason)}</span>`
  }
  if (r.fully_synced.value) extra = ' <span class="tag" style="background:#e8f8f0;color:#0c7a4e;border-color:#b8e6cc;margin-left:8px">完全同步</span>'
  $('#banner').className = `banner ${r.banner.level}`
  $('#banner').innerHTML = `<span class="bicon">${icon}</span><span>${esc(r.banner.text)}${extra}</span>`
}

function renderVersionSelectors(r) {
  $('#srcVSel').innerHTML = versionOptions(state.doc, r.languages.source, r.versions.source)
  $('#tgtVSel').innerHTML = r.languages.target_available
    ? versionOptions(state.doc, r.languages.target, r.versions.target)
    : '<option value="">— 暂缺 —</option>'
  $('#srcVSel').value = String(r.versions.source)
  $('#tgtVSel').value = r.languages.target_available ? String(r.versions.target) : ''
}

function renderLockButton(r) {
  const b = $('#lockBtn')
  if (r.lock) {
    b.textContent = `🔒 整篇锁 v${r.lock.src_version}${r.lock.stale ? '（滞后）' : ''}`
    b.style.borderColor = r.lock.stale ? 'var(--warn)' : 'var(--ok)'
    b.title = '点击清除整篇语言锁'
  } else {
    b.textContent = '🔓 锁定当前原文版本'
    b.style.borderColor = ''
    b.title = '以当前原文版本建立整篇语言锁'
  }
}

function renderBody(r) {
  const src = $('#srcBody'); const tgt = $('#tgtBody')
  src.innerHTML = ''; tgt.innerHTML = ''
  if (!r.languages.target_available) {
    tgt.innerHTML = `<div class="miss-placeholder">该语言（${esc(r.languages.target)}）版本暂缺。<br>右栏暂无译文；左栏原文可正常阅读，待该语言发布后自动建立翻译单元。</div>`
  }

  for (const g of r.groups) {
    for (const n of g.src) src.appendChild(nodeEl(n, g, 'src'))
    if (r.languages.target_available) {
      if (g.tgt.length === 0) {
        tgt.appendChild(missingEl(g))
      } else {
        for (const n of g.tgt) tgt.appendChild(nodeEl(n, g, 'tgt'))
      }
    }
  }
  // 来源缺失：仅补「连 missing 组都没生成」的孤立节点（如全新章节标题），避免重复
  const groupedKeys = new Set(r.groups.flatMap((g) => g.src_keys))
  for (const iss of r.issues.source_missing) {
    if (groupedKeys.has(iss.node_key)) continue
    const el = document.createElement('div')
    el.className = 'miss-placeholder'
    el.style.margin = '8px 0'
    el.dataset.group = `g-issue-${iss.node_key}`
    el.textContent = `来源缺失：原文节点 ${iss.node_key} 没有任何对齐边（${iss.detail.heading_path || ''}）。请到审阅台人工补对齐/确认。`
    tgt.appendChild(el)
  }
}

function nodeEl(n, g, side) {
  const el = document.createElement('div')
  el.className = `node ${n.type}${n.heading_level ? ' heading-' + n.heading_level : ''}`
  el.dataset.node = n.node_key
  el.dataset.group = g.id
  el.dataset.status = g.status
  el.dataset.side = side

  let inner = ''
  if (n.type === 'code') {
    const snip = (state.reader.code_snippets || {})[n.code_sha]
    inner = `<div class="code-meta">${g.status === 'code_synced' ? '🔗 共享代码 · 两栏引用同一 sha' : '代码块'} · ${esc(n.code_sha.slice(0, 10))}</div>
      <pre class="code">${esc(snip ? snip.code : '（代码正文缺失）')}</pre>`
  } else {
    inner = `<div class="ntext">${renderInline(n.raw_content, n.tokens)}</div>`
  }

  const origin = g.origins.length ? `<span class="pill origin">${g.origins.includes('manual') ? '人工对齐' : '自动对齐'}${g.src.length + g.tgt.length > 2 ? ' · 多对多' : ''}</span>` : ''
  const reason = g.detail && g.detail.reason && !['verified', 'code_synced'].includes(g.status) ? `<span class="hint">${esc(reasonText(g))}</span>` : ''
  let foot = `<div class="nfoot"><span class="pill ${g.status}">${STATUS_LABEL[g.status] || g.status}</span>${origin}${reason}`
  if (side === 'tgt' && n.type !== 'code') {
    foot += `<span class="spacer" style="flex:1"></span><button class="minibtn" data-act="edit">✏️ 翻译/复核</button>`
  }
  foot += `</div>`
  el.innerHTML = inner + foot

  el.addEventListener('click', (e) => {
    if (e.target.dataset.act === 'edit') { openEditor(g); return }
    highlightGroup(g.id); state.activeNode = n.node_key; history.replaceState(null, '', location.pathname + '?' + readerQuery(state.reader))
  })
  return el
}

function codeBySha(sha) { return state.codeCache?.[sha] ?? '' }
function reasonText(g) {
  const map = {
    target_side_absent: '该段暂无译文节点', no_alignment_edge: '未建立对齐',
    edge_dangling_source: '对齐边指向的源节点在此版本已消失（原文重排/删除）',
    manual_and_auto_overlap: '人工边与自动边重叠', two_translators_edit_conflict: '两位译者并发编辑未合并',
    token_mismatch: '译文丢失了参数名/不可翻译标记: ' + ((g.detail.missingTokens) || []).join(' '),
    shared_code_changed_on_source: '源端共享代码已更新', shared_code_no_edge: '共享代码未建边（按 sha 仍一致展示）'
  }
  return map[g.detail.reason] || g.detail.reason || ''
}

function missingEl(g) {
  const el = document.createElement('div')
  el.className = 'node'
  el.dataset.group = g.id
  el.dataset.node = (g.src_keys[0] || '') + ':missing'
  el.dataset.status = 'missing'
  el.innerHTML = `<div class="miss-placeholder">译文缺失：原文「${esc(g.src.map((n) => n.raw_content).join(' / ').slice(0, 60))}」在此语言版本没有对应段。</div>
    <div class="nfoot"><span class="pill missing">${STATUS_LABEL.missing}</span><span class="spacer" style="flex:1"></span><button class="minibtn" data-act="review-missing">报审阅台</button></div>`
  el.addEventListener('click', (e) => { if (e.target.dataset.act === 'review-missing') openReview() })
  return el
}

// ============ 语义滚动同步 ============
// 不按像素/数组下标，而是以「当前位于视口中心的语义节点」为锚，把对栏滚到同组对应节点。
let syncing = false
function setupScrollSync() {
  const a = $('#srcPane'), b = $('#tgtPane')
  a.onscroll = () => onScroll(a, b)
  b.onscroll = () => onScroll(b, a)
}
function onScroll(fromPane, toPane) {
  if (syncing) return
  const measure = (pane) => {
    const pr = pane.getBoundingClientRect()
    const nodes = [...pane.querySelectorAll('.node, .miss-placeholder')]
    return {
      rects: nodes.map((n) => { const r = n.getBoundingClientRect(); return { id: n.dataset.group, top: r.top, height: r.height } }),
      geo: { scrollTop: pane.scrollTop, viewportTop: pr.top, clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight }
    }
  }
  const f = measure(fromPane); const t = measure(toPane)
  const mapped = mapScroll(f.rects, t.rects, f.geo, t.geo)
  if (!mapped) return
  syncing = true
  toPane.scrollTop += mapped.delta
  highlightGroup(mapped.groupId)
  const anchor = centerNode(fromPane)
  if (anchor) state.activeNode = anchor.dataset.node
  clearTimeout(scrollTimer); scrollTimer = setTimeout(() => { syncing = false }, 120)
}
let scrollTimer
function centerNode(pane) {
  const nodes = [...pane.querySelectorAll('.node, .miss-placeholder')]
  const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2
  let best = null, bestD = Infinity
  for (const n of nodes) {
    const r = n.getBoundingClientRect(); const c = r.top + r.height / 2
    const d = Math.abs(c - cy)
    if (d < bestD) { bestD = d; best = n }
  }
  return best
}
function highlightGroup(group) {
  document.querySelectorAll('.node.active').forEach((n) => n.classList.remove('active'))
  document.querySelectorAll(`[data-group="${CSS.escape(group)}"]`).forEach((n) => n.classList.add('active'))
}
function scrollToNode(nodeKey, smooth) {
  const sel = `[data-node="${CSS.escape(nodeKey)}"]`
  const el = $('#srcPane').querySelector(sel) || $('#tgtPane').querySelector(sel)
  if (!el) return
  const pane = el.closest('.pane')
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' })
  highlightGroup(el.dataset.group)
}

// ============ 翻译弹层（乐观锁 + 冲突合并） ============
let editing = null
function openEditor(group) {
  const unit = group.unit
  if (!unit) { alert('该语言还没有翻译单元（可能语言暂缺）'); return }
  editing = { group, unit }
  $('#edTitle').textContent = `翻译段 · ${group.src_keys.join(', ')}`
  $('#edStatus').textContent = STATUS_LABEL[group.status] || group.status
  $('#edStatus').className = `pill ${group.status}`
  $('#edSource').innerHTML = group.src.map((n) => `<div class="ntext">${renderInline(n.raw_content, n.tokens)}</div>`).join('')
  $('#edBody').value = unit.body || ''
  $('#edMeta').textContent = `rev ${unit.revision} · 更新于 ${unit.updated_at ? new Date(unit.updated_at).toLocaleString() : '—'}`
  $('#edConflict').classList.add('hidden')
  $('#editor').classList.remove('hidden')
}
function closeEditor() { $('#editor').classList.add('hidden'); editing = null }

async function saveDraft() {
  const { group, unit } = editing
  try {
    await post('/api/unit/save', { doc: state.reader.doc.slug, node: unit.src_node_key, tgt: state.tgt, body: $('#edBody').value, actor: currentActor(), baseRevision: unit.revision })
    closeEditor(); await loadReader()
  } catch (e) {
    if (e.status === 409) showConflict(unit, e)
    else alert(e.message)
  }
}
async function submit() {
  const { unit } = editing
  await post('/api/unit/submit', { doc: state.reader.doc.slug, node: unit.src_node_key, tgt: state.tgt, actor: currentActor() })
  closeEditor(); await loadReader()
}
async function verify() {
  const { unit } = editing
  await post('/api/unit/verify', { doc: state.reader.doc.slug, node: unit.src_node_key, tgt: state.tgt, actor: currentActor() })
  closeEditor(); await loadReader()
}
function showConflict(unit, e) {
  $('#edBaseRev').textContent = unit.revision
  $('#edSrvRev').textContent = e.serverRevision
  $('#edSrvBy').textContent = '另一位译者'
  $('#edMine').textContent = $('#edBody').value
  $('#edSrv').textContent = e.serverBody || '（服务端版本）'
  $('#edConflict').classList.remove('hidden')
  editing.conflictId = e.conflictId
  editing.serverBody = e.serverBody
  editing.serverRevision = e.serverRevision
}
async function mergeConflict() {
  const { conflictId } = editing
  await post('/api/conflict/resolve', { doc: state.reader.doc.slug, conflictId, body: $('#edBody').value, actor: currentActor() })
  closeEditor(); await loadReader()
}
const currentActor = () => $('#actorInput')?.value || window.__actor || (window.__actor = prompt('你的译者标识（如 translator-a）：') || 'translator')

// ============ 审阅台 ============
async function openReview() {
  const { queue } = await api(`/api/review?doc=${encodeURIComponent(state.reader.doc.slug)}`)
  const box = $('#rvList')
  if (!queue.length) { box.innerHTML = '<p class="hint">没有待处理项 🎉</p>' }
  else box.innerHTML = queue.map((it) => reviewItem(it)).join('')
  $('#reviewPanel').classList.remove('hidden')
}
function reviewItem(it) {
  return `<div class="rv-item ${it.kind}" data-id="${it.id}" data-kind="${it.kind}">
    <div class="rv-top"><span class="pill ${it.kind.includes('conflict') ? 'conflict' : 'stale'}">${kindLabel(it.kind)}</span>
      <span>${esc(it.ref_key || '')}</span>
      <span style="margin-left:auto">${it.status === 'open' ? '待处理' : it.status}</span></div>
    <pre>${esc(JSON.stringify(it.detail || {}, null, 2))}</pre>
    ${it.status === 'open' ? `<div class="rv-actions">
      ${it.kind === 'edit_conflict' ? '<button class="minibtn" data-rv="merge">打开该段并人工合并</button>' : ''}
      <button class="minibtn" data-rv="resolve">人工确认（关闭）</button>
      <button class="minibtn" data-rv="ignore">忽略</button>
    </div>` : ''}
  </div>`
}
function kindLabel(k) {
  return { source_missing: '来源缺失', alignment_conflict: '对齐冲突', token_mismatch: '标记不一致', edit_conflict: '编辑冲突' }[k] || k
}

// 事件委托（只绑一次）
function bindReviewActions(box) {
  box.onclick = async (e) => {
    const btn = e.target.closest('button[data-rv]'); if (!btn) return
    const item = btn.closest('.rv-item')
    const id = Number(item.dataset.id); const kind = item.dataset.kind; const act = btn.dataset.rv
    if (act === 'merge') {
      // 打开冲突段：detail 里有 srcNodeKey/actor，直接定位编辑器
      const { queue } = await api(`/api/review?doc=${encodeURIComponent(state.reader.doc.slug)}`)
      const it = queue.find((x) => x.id === id)
      const node = it?.detail?.srcNodeKey
      $('#reviewPanel').classList.add('hidden')
      if (node) {
        const g = state.reader.groups.find((x) => x.src_keys.includes(node))
        if (g) openEditor(g)
      }
      return
    }
    await post('/api/review/act', { doc: state.reader.doc.slug, reviewId: id, action: act, actor: currentActor(), detail: {} })
    await openReview(); await loadReader()
  }
}

// ============ 搜索（进入历史版） ============
let searchTimer
function bindSearch() {
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(doSearch, 250)
  })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.searchbox')) $('#searchResults').classList.add('hidden')
  })
}
async function doSearch() {
  const q = $('#searchInput').value.trim()
  const box = $('#searchResults')
  if (!q) { box.classList.add('hidden'); return }
  const { hits } = await api(`/api/search?q=${encodeURIComponent(q)}`)
  if (!hits.length) { box.innerHTML = '<div class="hit hint">无命中</div>'; box.classList.remove('hidden'); return }
  box.innerHTML = hits.map((h, i) => `<div class="hit" data-i="${i}">
    <div class="hit-top"><span class="tag lang">${esc(h.lang)}</span>
      <b>${esc(h.title)}</b>
      <span style="margin-left:auto">v${h.version}${h.is_latest ? '' : '<span class="tag hist">历史版</span>'}</span></div>
    <div class="hit-snip">${highlight(h.snippet, q)}</div>
    <div class="hit-top"><span class="tag">${esc(h.heading_path || h.type)}</span></div>
  </div>`).join('')
  box.classList.remove('hidden')
  box.querySelectorAll('.hit').forEach((el) => {
    el.addEventListener('click', () => {
      const h = hits[Number(el.dataset.i)]
      applyHit(h); box.classList.add('hidden')
    })
  })
}
function highlight(text, q) {
  const t = q.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  let html = esc(text)
  for (const w of t) html = html.replace(new RegExp(`(${w})`, 'gi'), '<mark>$1</mark>')
  return html
}
async function applyHit(h) {
  state.doc = h.doc; state.tgt = h.lang === h.source_lang ? 'en' : h.lang
  $('#docSel').value = state.doc
  if (h.lang === h.source_lang) { state.srcV = h.version; state.tgtV = undefined }
  else { state.tgtV = h.version; state.srcV = undefined }
  state.mode = 'graph'; state.anchorNode = h.node_key; state.activeNode = h.node_key
  $('#modeSel').value = 'graph'
  await loadReader()
}

// ============ 事件绑定 ============
function bindControls() {
  $('#docSel').addEventListener('change', async (e) => { state.doc = e.target.value; state.srcV = state.tgtV = undefined; state.anchorNode = null; await loadReader() })
  $('#tgtSel').addEventListener('change', async (e) => { state.tgt = e.target.value; state.tgtV = undefined; state.anchorNode = null; await loadReader() })
  $('#modeSel').addEventListener('change', async (e) => { state.mode = e.target.value; await loadReader() })
  $('#srcVSel').addEventListener('change', async (e) => { state.srcV = Number(e.target.value); state.anchorNode = null; await loadReader() })
  $('#tgtVSel').addEventListener('change', async (e) => { state.tgtV = e.target.value ? Number(e.target.value) : undefined; state.anchorNode = null; await loadReader() })
  $('#lockBtn').addEventListener('click', async () => {
    if (state.reader.lock) await post('/api/lock/clear', { doc: state.reader.doc.slug, tgt: state.tgt })
    else await post('/api/lock/set', { doc: state.reader.doc.slug, tgt: state.tgt, actor: currentActor() })
    await loadReader()
  })
  $('#reviewBtn').addEventListener('click', openReview)
  $('#rvClose').addEventListener('click', () => $('#reviewPanel').classList.add('hidden'))
  bindReviewActions($('#rvList'))
  $('#edClose').addEventListener('click', closeEditor)
  $('#edSave').addEventListener('click', saveDraft)
  $('#edSubmit').addEventListener('click', submit)
  $('#edVerify').addEventListener('click', verify)
  document.addEventListener('click', (e) => { if (e.target.id === 'mergeBtn') mergeConflict() })
  bindSearch()
}

// 从 URL 恢复
function applyUrl() {
  const p = new URLSearchParams(location.search)
  if (p.get('doc')) state.doc = p.get('doc')
  if (p.get('tgt')) state.tgt = p.get('tgt')
  if (p.get('mode')) state.mode = p.get('mode')
  if (p.get('srcV')) state.srcV = Number(p.get('srcV'))
  if (p.get('tgtV')) state.tgtV = Number(p.get('tgtV'))
  if (p.get('node')) { state.anchorNode = p.get('node'); state.activeNode = p.get('node') }
  $('#tgtSel').value = state.tgt; $('#modeSel').value = state.mode
}

// 代码正文随 reader.code_snippets 返回（两栏共享同一份，译文不复制）
function primeCodeCache(r) {
  state.codeCache = {}
  if (r?.code_snippets) for (const [sha, v] of Object.entries(r.code_snippets)) state.codeCache[sha] = v.code
}

function renderReviewBadge(r) {
  const n = r.issues.queue.filter((x) => x.kind).length
  const b = $('#reviewBadge')
  if (n > 0) { b.textContent = n; b.classList.remove('hidden') } else b.classList.add('hidden')
}

;(async function main() {
  applyUrl()
  await loadDocs()
  bindControls()
  primeCodeCache()
  await loadReader()
})()
