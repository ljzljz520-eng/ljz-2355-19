/* 双语对照阅读器：左右栏按语义节点同步，状态与基线来自内容 API */
const $ = (s) => document.querySelector(s)
const api = async (path, opts) => {
  const res = await fetch(path, opts ? { method: opts.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body ?? {}) } : undefined)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e }
  return data
}

const STATUS_LABEL = { verified: '已验证', needs_review: '待复核', missing_source: '来源缺失', conflict: '对齐冲突', draft: '草稿', untranslated: '未翻译' }
const LOCK_LABEL = { in_sync: '🔒 语言锁：同步', stale: '🔓 语言锁：已过期', broken: '⚡ 语言锁：与对齐图冲突', unlocked: '未锁定' }

const state = {
  docs: [], docId: null, view: null, report: null,
  srcVersion: null, tgtVersion: null, historical: false,
  segMap: { src: new Map(), tgt: new Map() }, // seg_key -> HTMLElement
  links: new Map(), // seg_key -> [对侧 seg_key]
  scrolling: 0,
  keepScroll: null, // 跨版本/重渲染时保留的语义锚点 {docId, side, segKey}
}

// ---------- 初始化 ----------
async function init() {
  const { docs } = await api('/api/docs')
  state.docs = docs
  const sel = $('#docSelect')
  sel.innerHTML = docs.map((d) => `<option value="${d.id}">${d.title}（${d.id}）</option>`).join('')
  state.docId = new URLSearchParams(location.search).get('doc') ?? docs[0]?.id
  sel.value = state.docId
  sel.onchange = () => { state.docId = sel.value; state.srcVersion = state.tgtVersion = null; load() }
  $('#latestBtn').onclick = () => { state.srcVersion = state.tgtVersion = null; reloadPreserving() }
  $('#graphBtn').onclick = toggleGraph
  $('#lockBtn').onclick = onLock
  $('#srcVersionSelect').onchange = (e) => { state.srcVersion = numOrNull(e.target.value); reloadPreserving() }
  $('#tgtVersionSelect').onchange = (e) => { state.tgtVersion = numOrNull(e.target.value); reloadPreserving() }
  initSearch()
  await load()
}
const numOrNull = (v) => (v === '' || v == null ? null : Number(v))

async function load() {
  // 捕获重载前的语义锚点（仅在同一文档内跨版本/重渲染时保留滚动位置）
  const keep = state.keepScroll
  state.keepScroll = null
  const q = new URLSearchParams({ tgt: 'en' })
  if (state.srcVersion) q.set('srcVersion', state.srcVersion)
  if (state.tgtVersion) q.set('tgtVersion', state.tgtVersion)
  const [view, report, srcVers, tgtVers] = await Promise.all([
    api(`/api/docs/${state.docId}/bilingual?${q}`),
    api(`/api/docs/${state.docId}/sync-report?tgt=en`),
    api(`/api/docs/${state.docId}/versions?lang=zh`),
    api(`/api/docs/${state.docId}/versions?lang=en`),
  ])
  state.view = view; state.report = report
  state.historical = !view.src.isLatest || (view.tgt && !view.tgt.isLatest)
  fillVersions('#srcVersionSelect', srcVers.versions, view.src.versionNo)
  fillVersions('#tgtVersionSelect', tgtVers.versions, view.tgt?.versionNo)
  renderBanner()
  renderPanes()
  if (keep) restoreSemanticScroll(keep)
  if (!$('#graphPanel').classList.contains('hidden')) renderGraph()
}

// 重载（版本切换/确认/编辑后）尽量把视图带回同一语义节点，而非回到页首
function reloadPreserving() {
  const anchor = firstVisible($('#leftPane'))
  state.keepScroll = anchor
    ? { docId: state.docId, side: 'src', segKey: anchor.dataset.segKey }
    : null
  return load()
}

function restoreSemanticScroll(keep) {
  if (keep.docId !== state.docId) return // 跨文档不保留（不同语义节点空间）
  const panes = { src: $('#leftPane'), tgt: $('#rightPane') }
  const el = state.segMap[keep.side]?.get(keep.segKey)
  if (!el) return
  // 主锚点归位（块顶距视口顶部 16px）
  panes[keep.side].scrollTop += el.getBoundingClientRect().top - panes[keep.side].getBoundingClientRect().top - 16
  // 对侧按语义链接同步到对应节点（一对多取首个），保持左右语义位置一致
  const refs = state.links.get(`${keep.side}:${keep.segKey}`) ?? []
  for (const ref of refs) {
    const i = ref.indexOf(':')
    const other = state.segMap[ref.slice(0, i)]?.get(ref.slice(i + 1))
    if (other) {
      const op = panes[keep.side === 'src' ? 'tgt' : 'src']
      op.scrollTop += other.getBoundingClientRect().top - op.getBoundingClientRect().top - 16
      break
    }
  }
}

function fillVersions(sel, versions, current) {
  const el = $(sel)
  el.innerHTML = versions.map((v) =>
    `<option value="${v.version_no}" ${v.version_no === current ? 'selected' : ''}>v${v.version_no}${v.version_no === versions[0].version_no ? '（最新）' : '（历史）'} · ${v.author ?? ''}</option>`
  ).join('')
}

// ---------- 横幅：明确翻译基于哪版原文，绝不把过期译文包装成完全同步 ----------
function renderBanner() {
  const { banner, summary, tgt } = state.view
  const el = $('#banner')
  el.className = 'banner ' + (state.historical ? 'historical' : banner.fullySynced ? 'synced' : 'stale')
  const chips = []
  if (state.historical) chips.push(`<span class="chip">⚠ 正在查看历史版本，非最新内容</span>`)
  if (!tgt) chips.push(`<span class="chip">该语言暂缺：英文版尚未翻译</span>`)
  else if (banner.fullySynced) chips.push(`<span class="chip">✅ 译文与原文 v${banner.currentSrcVersion} 完全同步</span>`)
  else {
    chips.push(`<span class="chip">译文基于原文 v${banner.basedOnSrcVersion ?? '?'}，当前原文 v${banner.currentSrcVersion}</span>`)
    if (summary.needs_review) chips.push(`<span class="chip">${summary.needs_review} 段待复核</span>`)
    if (summary.missing_source) chips.push(`<span class="chip">${summary.missing_source} 段来源缺失</span>`)
    if (summary.conflict) chips.push(`<span class="chip">${summary.conflict} 段对齐冲突</span>`)
    if (summary.untranslated) chips.push(`<span class="chip">${summary.untranslated} 段未翻译</span>`)
  }
  chips.push(`<span class="chip">${LOCK_LABEL[state.report.lockStatus]}</span>`)
  el.innerHTML = chips.join('')
  $('#lockBtn').textContent = state.report.lock ? '解除语言锁' : '锁定整篇'
}

// ---------- 左右栏渲染（按语义节点配对） ----------
function renderPanes() {
  const { pairs, orphanTgt, tgt } = state.view
  state.segMap = { src: new Map(), tgt: new Map() }
  state.links = new Map()
  const left = $('#leftPane'), right = $('#rightPane')
  left.innerHTML = ''; right.innerHTML = ''

  if (!tgt) {
    for (const p of pairs) {
      left.appendChild(segCard(p.src, 'src'))
      right.appendChild(placeholder('该语言暂缺 / Not yet translated'))
    }
    return
  }

  for (const p of pairs) {
    const srcEl = segCard(p.src, 'src', p.status)
    left.appendChild(srcEl)
    state.segMap.src.set(p.src.seg_key, srcEl)
    const tgtKeys = []
    if (p.targets.length === 0) {
      right.appendChild(placeholder('未翻译 / Untranslated'))
    } else {
      const wrap = document.createElement('div')
      for (const t of p.targets) {
        if (!t.segment) { wrap.appendChild(placeholder(`对齐目标 ${t.link.tgt_key} 不在当前译文版本`)); continue }
        const el = segCard(t.segment, 'tgt', t.status?.status ?? 'draft', t.status)
        wrap.appendChild(el)
        state.segMap.tgt.set(t.segment.seg_key, el)
        tgtKeys.push(t.segment.seg_key)
      }
      right.appendChild(wrap)
    }
    if (tgtKeys.length) {
      state.links.set(`src:${p.src.seg_key}`, tgtKeys.map((k) => `tgt:${k}`))
      for (const k of tgtKeys) {
        const cur = state.links.get(`tgt:${k}`) ?? []
        cur.push(`src:${p.src.seg_key}`)
        state.links.set(`tgt:${k}`, cur)
      }
    }
  }
  if (orphanTgt.length) {
    const h = document.createElement('h3')
    h.textContent = '⚠ 来源缺失的译段（原文已删除或对齐悬空）'
    right.appendChild(h)
    for (const o of orphanTgt) {
      const el = segCard(o.segment, 'tgt', 'missing_source', o.status)
      el.classList.add('orphan')
      right.appendChild(el)
      state.segMap.tgt.set(o.segment.seg_key, el)
    }
  }
}

function segCard(seg, side, status, statusDetail) {
  const el = document.createElement('div')
  el.className = 'seg'
  el.dataset.segKey = seg.seg_key
  el.dataset.side = side
  const badge = status ? `<span class="badge ${status}">${STATUS_LABEL[status] ?? status}</span>` : ''
  const hist = side === 'src' && !state.view.src.isLatest || side === 'tgt' && !state.view.tgt?.isLatest ? '<span class="badge hist">历史版</span>' : ''
  let body = ''
  if (seg.seg_type === 'code') {
    body = `<div class="shared-code">⇄ 共享代码块 <code>${seg.code_ref}</code>（更新于 ${seg.code?.updated_at?.slice(0, 10) ?? '?'}，双语引用同一代码，未复制）</div><pre><code>${escapeHtml(seg.code?.content ?? '')}</code></pre>`
  } else if (seg.seg_type === 'heading') {
    body = `<h2>${escapeHtml(seg.content)}</h2>`
  } else {
    body = `<p>${escapeHtml(seg.content)}</p>`
  }
  const drift = statusDetail?.driftedSrcKeys?.length ? `<span class="badge needs_review">源段已改: ${statusDetail.driftedSrcKeys.join(', ')}</span>` : ''
  el.innerHTML = `<div class="meta"><span class="key">${seg.seg_key}</span>${badge}${hist}${drift}</div>${body}
    <div class="actions">${side === 'tgt' && status && status !== 'verified' ? '<button data-act="confirm">确认无误</button>' : ''}${side === 'tgt' ? '<button data-act="edit">编辑译文</button>' : ''}</div>`
  el.addEventListener('click', (e) => {
    const act = e.target.dataset?.act
    if (act === 'confirm') return confirmSegment(seg.seg_key)
    if (act === 'edit') return editSegment(seg, statusDetail)
    highlight(seg.seg_key, side)
  })
  return el
}

const placeholder = (text) => {
  const el = document.createElement('div')
  el.className = 'seg placeholder'
  el.textContent = text
  return el
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ---------- 交叉高亮（一对多全部高亮） ----------
function highlight(segKey, side) {
  document.querySelectorAll('.seg.linked').forEach((e) => e.classList.remove('linked'))
  const self = state.segMap[side].get(segKey)
  self?.classList.add('linked')
  for (const ref of state.links.get(`${side}:${segKey}`) ?? []) {
    const i = ref.indexOf(':') // seg_key 本身含冒号，只切第一个
    const s = ref.slice(0, i), k = ref.slice(i + 1)
    const el = state.segMap[s]?.get(k)
    el?.classList.add('linked')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

// ---------- 语义滚动同步：按最近可见语义锚点对齐，而非滚动比例 ----------
function setupScrollSync() {
  const panes = { src: $('#leftPane'), tgt: $('#rightPane') }
  for (const [side, pane] of Object.entries(panes)) {
    pane.addEventListener('scroll', () => {
      if (state.scrolling) return
      const other = side === 'src' ? 'tgt' : 'src'
      const anchor = firstVisible(pane)
      if (!anchor) return
      const targets = state.links.get(`${side}:${anchor.dataset.segKey}`)
      const targetKey = targets?.[0]?.slice(targets[0].indexOf(':') + 1)
      const targetEl = targetKey && state.segMap[other]?.get(targetKey)
      if (!targetEl) return
      state.scrolling++
      const op = panes[other]
      // 语义锚点对齐：让对侧对应段滚动到与本侧锚点相同的视口位置
      const delta = targetEl.getBoundingClientRect().top - anchor.getBoundingClientRect().top
      op.scrollTop += delta
      setTimeout(() => state.scrolling--, 60)
    }, { passive: true })
  }
}
function firstVisible(pane) {
  for (const el of pane.querySelectorAll('.seg[data-seg-key]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > pane.getBoundingClientRect().top + 40) return el
  }
  return null
}

// ---------- 人工确认 / 编辑译文（乐观锁 + 冲突入口） ----------
async function confirmSegment(tgtKey) {
  try {
    await api(`/api/docs/${state.docId}/confirm`, { body: { tgtLang: 'en', tgtKey, reviewer: 'reviewer-ui' } })
    await reloadPreserving()
  } catch (e) { showModal('无法确认', `<p>${escapeHtml(e.message)}</p>`) }
}

function editSegment(seg, statusDetail) {
  const lockVersion = statusDetail?.lock_version ?? null
  showModal(`编辑译文 · ${seg.seg_key}`, `
    <textarea id="editArea">${escapeHtml(seg.content)}</textarea>
    <p style="color:#64748b;font-size:12px">基于锁版本 lock_version=${lockVersion ?? '无'} 提交；若他人已修改同段，将收到冲突提示。</p>`,
    async () => {
      const content = $('#editArea').value
      try {
        const r = await api(`/api/docs/${state.docId}/translations`, { body: { tgtLang: 'en', tgtKey: seg.seg_key, content, translator: 'translator-ui', expectedLockVersion: lockVersion } })
        if (r.warnings?.length) showModal('已保存，但有不可翻译标记警告', `<div class="warn-box">${r.warnings.map(escapeHtml).join('<br>')}</div>`)
        await reloadPreserving()
      } catch (e) {
        if (e.status === 409) return showConflict(seg, content, e.data)
        showModal('保存失败', `<p>${escapeHtml(e.message)}</p>`)
      }
    })
}

function showConflict(seg, myContent, conflict) {
  const cur = conflict.current
  showModal('⚡ 编辑冲突：该段已被他人修改', `
    <div class="conflict-box">
      <b>${escapeHtml(cur?.translator ?? '另一位译者')}</b> 已更新此段（lock_version=${cur?.lock_version}）。<br>
      你的版本基于 lock_version=${cur ? cur.lock_version - 1 : '?'}。
    </div>
    <p>你的内容：</p><textarea id="editArea">${escapeHtml(myContent)}</textarea>
    <p style="font-size:12px;color:#64748b">确认将以最新锁版本重新提交（覆盖前请人工核对）。</p>`,
    async () => {
      await api(`/api/docs/${state.docId}/translations`, { body: { tgtLang: 'en', tgtKey: seg.seg_key, content: $('#editArea').value, translator: 'translator-ui', expectedLockVersion: cur?.lock_version ?? null } })
      await reloadPreserving()
    })
}

// ---------- 语言锁 ----------
async function onLock() {
  try {
    if (state.report.lock) await api(`/api/docs/${state.docId}/lock`, { method: 'DELETE' })
    else await api(`/api/docs/${state.docId}/lock`, { body: { tgtLang: 'en', by: 'reviewer-ui' } })
    await reloadPreserving()
  } catch (e) {
    const blockers = e.data?.blockers?.map((b) => `<li><code>${b.srcKey}</code> — ${STATUS_LABEL[b.status] ?? b.status}</li>`).join('') ?? ''
    showModal('无法锁定整篇', `<p>${escapeHtml(e.message)}</p>${blockers ? `<ul>${blockers}</ul>` : ''}<p>整篇语言锁要求段落级对齐图全部已验证；请先处理上述段落。</p>`)
  }
}

// ---------- 对齐图面板 ----------
function toggleGraph() {
  $('#graphPanel').classList.toggle('hidden')
  $('#graphBtn').classList.toggle('active')
  renderGraph()
}
function renderGraph() {
  const r = state.report
  $('#syncReport').innerHTML = `
    <div class="report-row"><span>整篇语言锁</span><b>${r.lock ? `v${r.lock.srcVersion} ⇄ v${r.lock.tgtVersion}（${r.lock.lockedBy}）` : '未锁定'}</b></div>
    <div class="report-row"><span>锁状态</span><b>${LOCK_LABEL[r.lockStatus]}</b></div>
    <div class="report-row"><span>当前版本</span><b>原文 v${r.currentVersions.src} ⇄ 译文 v${r.currentVersions.tgt ?? '暂缺'}</b></div>
    <div class="report-row"><span>可展示为“完全同步”</span><b>${r.presentableAsSynced ? '是' : '否'}</b></div>
    ${r.drifted.map((d) => `<div class="report-row"><span><code>${d.srcKey}</code></span><b class="badge ${d.status}">${STATUS_LABEL[d.status]}</b></div>`).join('')}`
  $('#alignGraph').innerHTML = state.view.pairs.map((p) => `
    <div class="align-row">
      <span>${p.src.seg_key}</span><span class="arrow">→</span>
      <span>${p.targets.length ? p.targets.map((t) => `${t.link.tgt_key}${t.link.confirmed ? ' ✓' : ''}`).join(' + ') : '<i>未翻译</i>'}</span>
      <span class="badge ${p.status}">${STATUS_LABEL[p.status]}</span>
    </div>`).join('') +
    (state.view.orphanTgt.length ? `<h4>来源缺失</h4>` + state.view.orphanTgt.map((o) => `<div class="align-row"><span>${o.segment.seg_key}</span><span class="badge missing_source">来源缺失</span></div>`).join('') : '')
}

// ---------- 搜索（可进入历史版） ----------
function initSearch() {
  const input = $('#searchInput'), box = $('#searchResults')
  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const q = input.value.trim()
      if (!q) return box.classList.add('hidden')
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`)
      box.innerHTML = results.length ? results.map((r, i) => `
        <div class="search-item" data-i="${i}">
          <div>${escapeHtml(r.snippet)}</div>
          <div class="meta">${r.docId} · ${r.lang} · v${r.versionNo} ${r.isLatest ? '' : '<span class="hist">历史版本</span>'} · <code>${r.segKey}</code></div>
        </div>`).join('') : '<div class="search-item">无结果</div>'
      box.classList.remove('hidden')
      box.querySelectorAll('.search-item[data-i]').forEach((el) => {
        el.onclick = () => {
          const r = results[Number(el.dataset.i)]
          state.docId = r.docId
          $('#docSelect').value = r.docId
          // 进入命中版本：中文结果定原文版本，英文结果定译文版本
          state.srcVersion = r.lang === 'zh' ? r.versionNo : null
          state.tgtVersion = r.lang === 'en' ? r.versionNo : null
          box.classList.add('hidden')
          load().then(() => {
            const el2 = state.segMap[r.lang === 'zh' ? 'src' : 'tgt']?.get(r.segKey)
            el2?.scrollIntoView({ block: 'center' })
            el2?.classList.add('linked')
          })
        }
      })
    }, 250)
  })
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) box.classList.add('hidden') })
}

// ---------- 模态框 ----------
let modalOk = null
function showModal(title, bodyHtml, onOk) {
  $('#modalTitle').textContent = title
  $('#modalBody').innerHTML = bodyHtml
  $('#modal').classList.remove('hidden')
  modalOk = onOk ?? null
  $('#modalOk').style.display = onOk ? '' : 'none'
}
$('#modalCancel').onclick = () => $('#modal').classList.add('hidden')
$('#modalOk').onclick = async () => { $('#modal').classList.add('hidden'); if (modalOk) await modalOk() }

setupScrollSync()
init().catch((e) => { document.body.innerHTML = `<pre style="padding:40px">加载失败：${escapeHtml(e.message)}</pre>` })
