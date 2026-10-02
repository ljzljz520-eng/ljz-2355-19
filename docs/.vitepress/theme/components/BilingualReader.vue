<script setup>
import { computed, onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue'
import SegmentView from './SegmentView.vue'
import {
  loadBilingual, runSearch, saveReview, decideOnProposal, resolveVersion,
  listDocs, resolveAnchorBetween
} from '../i18n/readerStore.js'
import { useSyncScroll } from '../composables/useSyncScroll.js'

const props = defineProps({
  docId: { type: String, required: true },
  lang: { type: String, default: 'en' },
  sourceVersion: { type: String, default: '' },
  enterSegment: { type: String, default: '' },
  openConflicts: { type: Boolean, default: false }
})

const docs = listDocs()
const docMeta = docs.find((d) => d.id === props.docId)
const versions = docMeta?.versions || []

const selectedVersion = ref(props.sourceVersion || versions[versions.length - 1]?.version)
const targetLang = ref(props.lang)
const mode = ref('paragraph') // 'paragraph' | 'lock' comparison view
const data = ref(null)
const activeId = ref(props.enterSegment || '')
const searchQ = ref('')
const searchHits = ref([])
const showConflicts = ref(props.openConflicts)
const notice = ref('')
const selectedNode = ref(null)
const reviewDraft = ref('')
const reviewBaseRevision = ref(null)
const anchorInfo = ref(null)

const leftPane = ref(null)
const rightPane = ref(null)
let unbindScroll = null
const { bind } = useSyncScroll()

const isZh = computed(() => targetLang.value === 'en') // UI: zh when reading zh+en

function t(zh, en) { return isZh.value ? zh : en }

function load(version = selectedVersion.value, keepAnchor = false) {
  const prevId = keepAnchor ? activeId.value : ''
  const prevVersion = data.value?.sourceVersion?.version
  const res = loadBilingual(props.docId, { lang: targetLang.value, sourceVersion: version })
  data.value = res

  if (keepAnchor && prevId && prevVersion && prevVersion !== version) {
    const mapped = resolveAnchorBetween(props.docId, prevVersion, version, prevId)
    anchorInfo.value = mapped
    activeId.value = mapped.segmentId || ''
  } else if (!activeId.value && props.enterSegment) {
    activeId.value = props.enterSegment
  }

  if (res.targetAvailable === false) {
    notice.value = t(
      `「${targetLang.value}」译文暂缺（${res.missing?.reason || ''}），右侧不显示任何"已同步"标记。`,
      `The ${targetLang.value} translation is not available yet (${res.missing?.reason || ''}). No sync claim is shown.`
    )
  } else if (res.isHistorical) {
    notice.value = t(
      `历史版本归档：当前展示基于原文 ${version}；最新原文为 ${res.latestSourceVersion}。状态仅反映该版本，不会包装成完全同步。`,
      `Frozen archive: based on source ${version}; latest source is ${res.latestSourceVersion}. States reflect this version only.`
    )
  } else if (res.lockVsGraph && !res.lockVsGraph.lockFullyConsistent) {
    notice.value = t(
      `整篇语言锁：译文基线为 ${res.lockVsGraph.lockBaseline}，当前原文已是 ${res.lockVsGraph.currentSourceVersion} —— 译文过期，不得视为完全同步。`,
      `Whole-document lock: translation baseline ${res.lockVsGraph.lockBaseline}, current source ${res.lockVsGraph.currentSourceVersion} — stale, not fully in sync.`
    )
  } else if (!res.summary.inSync) {
    notice.value = t('部分段落待复核或缺少翻译，未通过的段落已逐段标注。',
      'Some paragraphs need re-review or are untranslated; each is marked individually.')
  } else {
    notice.value = t('全部段落已验证且与当前原文一致。', 'All paragraphs verified against the current source.')
  }
  nextTick(scrollToActive)
}

// ---- source-pane rows in source order ------------------------------------
const rows = computed(() => {
  if (!data.value) return []
  const stateById = new Map(data.value.states.map((s) => [s.sourceId, s]))
  return data.value.sourceVersion.segments.map((seg) => {
    const st = stateById.get(seg.id)
    return { seg, state: st?.state || 'none', edges: st?.edges || [] }
  })
})

// ---- target units for a given source node (the 1:N-aware rendering) ------
const unitById = computed(() => {
  const m = new Map()
  for (const u of data.value?.units || []) m.set(u.id, u)
  return m
})

function targetsFor(row) {
  return row.edges
    .map((e) => ({ edge: e, unit: unitById.value.get(e.targetId) || null, state: e.state }))
}

const orphanEdges = computed(() => {
  if (!data.value) return []
  const sourceIds = new Set(data.value.sourceVersion.segments.map((s) => s.id))
  return data.value.graph.edges.filter((e) => !sourceIds.has(e.sourceId))
})

// group lookup for scroll sync
function groupOf(id) {
  const edges = data.value?.graph.edges || []
  const e = edges.find((x) => x.sourceId === id || x.targetId === id)
  if (e?.group) {
    return edges.filter((x) => x.group === e.group).flatMap((x) => [x.sourceId, x.targetId])
  }
  return null
}

function selectNode(rowOrEdge) {
  if (rowOrEdge?.seg) {
    selectedNode.value = { kind: 'source', row: rowOrEdge }
    activeId.value = rowOrEdge.seg.id
  }
}

function scrollToActive() {
  if (!activeId.value) return
  const id = activeId.value
  const el = leftPane.value?.querySelector(`[data-segment-id="${cssEsc(id)}"]`)
  if (el) el.scrollIntoView({ block: 'center' })
  const rel = rightPane.value?.querySelector(`[data-segment-id="${cssEsc(id)}"]`)
  if (rel) rel.scrollIntoView({ block: 'center' })
}

// ---- search ---------------------------------------------------------------
function doSearch() {
  searchHits.value = runSearch(searchQ.value, targetLang.value === 'en' ? 'zh' : 'en')
    .concat(runSearch(searchQ.value, 'en'))
    .slice(0, 12)
}
function openHit(hit) {
  // search into history: open the EXACT version the wording was found in
  selectedVersion.value = hit.docVersion
  activeId.value = hit.segmentId
  load(hit.docVersion)
  searchHits.value = []
  searchQ.value = ''
}

// ---- review workflow (incl. simulated two-translator collision) ----------
function startReview(target) {
  const row = selectedNode.value?.row
  if (!row) { notice.value = t('请先在左栏选择一个语义节点。', 'Select a semantic node in the left pane first.'); return }
  const unitText = (target.unit?.tokens || []).filter((x) => x.kind === 'text').map((x) => x.text).join('')
  reviewDraft.value = unitText
  reviewBaseRevision.value = target.edge.revision ?? null
  selectedNode.value.reviewTarget = target
}

function submitVerification() {
  const target = selectedNode.value?.reviewTarget
  const row = selectedNode.value?.row
  if (!target) return
  const res = saveReview({
    docId: props.docId,
    lang: targetLang.value,
    unitId: target.edge.targetId,
    sourceId: row.seg.id,
    sourceDocVersion: selectedVersion.value,
    tokens: [{ kind: 'text', text: reviewDraft.value }],
    reviewer: 'me',
    expectedRevision: reviewBaseRevision.value
  })
  if (res.status === 409) {
    notice.value = t(
      `冲突 409：${res.error.message}；服务端修订号 ${res.error.serverRevision}，你的基线 ${res.error.yourBaseRevision}。请择一：覆盖 / 变基 / 打开差异。`,
      `Conflict 409: ${res.error.message}; server revision ${res.error.serverRevision}, yours ${res.error.yourBaseRevision}. Choose overwrite / rebase / open-diff.`
    )
    return
  }
  notice.value = t('已保存验证状态，基线已更新。', 'Verification saved; baseline updated.')
  load(selectedVersion.value, true)
}

// Simulate the exact requirement: another translator edits the same unit.
function simulateOtherTranslator() {
  const target = selectedNode.value?.reviewTarget
  if (!target) return
  const r = saveReview({
    docId: props.docId, lang: targetLang.value, unitId: target.edge.targetId,
    sourceId: selectedNode.value.row.seg.id, sourceDocVersion: selectedVersion.value,
    tokens: [{ kind: 'text', text: '(edited by teammate meanwhile)' }],
    reviewer: 'teammate'
  })
  reviewBaseRevision.value = r.status === 200 ? r.review.revision - 1 : reviewBaseRevision.value
  notice.value = t('队友已提交该段的新版本（修订号已前进）。你再点"验证通过"将得到 409。',
    'A teammate committed a new revision of this unit. Your next verify will get 409.')
  load(selectedVersion.value, true)
}

function approveProposal(p, decision) {
  const r = decideOnProposal(p.id, decision, 'me')
  notice.value = r.status === 200
    ? t(`对齐提案 ${p.id} 已${decision === 'approved' ? '批准' : '驳回'}。`,
        `Proposal ${p.id} ${decision}.`)
    : `Proposal error ${r.status}: ${r.error.code}`
  load(selectedVersion.value, true)
}

function cssEsc(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) }

const lockComparison = computed(() => {
  const g = data.value?.lockVsGraph
  if (!g) return null
  return {
    ...g,
    verdict: g.lockFullyConsistent
      ? t('整篇锁与段落图一致，均对应当前原文。', 'Lock and paragraph graph agree on the current source.')
      : t('整篇锁声称的版本与段落图/当前原文不一致 —— 必须以段落级状态为准。',
          'The whole-document lock disagrees with the paragraph graph/current source — trust paragraph-level states.')
  }
})

// Load during setup (store/API are synchronous) so SSR also gets full content;
// scrollToActive no-ops without DOM.
load(selectedVersion.value)

onMounted(() => {
  nextTick(() => {
    if (leftPane.value && rightPane.value) {
      unbindScroll = bind({
        leftEl: leftPane.value, rightEl: rightPane.value, groupOf
      })
      scrollToActive()
    }
  })
})
onBeforeUnmount(() => unbindScroll && unbindScroll())
watch(selectedVersion, (v) => load(v, true))
watch(targetLang, () => load(selectedVersion.value))
</script>

<template>
  <div class="br-app">
    <!-- Toolbar -->
    <div class="br-toolbar">
      <div class="br-group">
        <label>{{ t('原文版本', 'Source version') }}</label>
        <select v-model="selectedVersion">
          <option v-for="v in versions" :key="v.version" :value="v.version">
            {{ v.version }}<template v-if="v.version === versions[versions.length-1].version"> · {{ t('最新', 'latest') }}</template>
          </option>
        </select>
      </div>
      <div class="br-group">
        <label>{{ t('译文语言', 'Translation') }}</label>
        <select v-model="targetLang">
          <option v-for="l in (docMeta?.languages || []).filter(x => x !== 'zh')" :key="l" :value="l">{{ l }}</option>
        </select>
      </div>
      <div class="br-group">
        <label>{{ t('对齐模型', 'Model') }}</label>
        <button class="br-btn" :class="{ active: mode === 'paragraph' }" @click="mode = 'paragraph'">
          {{ t('段落对齐图', 'Paragraph graph') }}
        </button>
        <button class="br-btn" :class="{ active: mode === 'lock' }" @click="mode = 'lock'">
          {{ t('整篇语言锁', 'Whole-doc lock') }}
        </button>
      </div>
      <div class="br-group br-search">
        <input v-model="searchQ" :placeholder="t('搜索（可命中历史版本）…', 'Search (history included)…')"
               @keyup.enter="doSearch" />
        <button class="br-btn" @click="doSearch">🔍</button>
        <div v-if="searchHits.length" class="br-hits">
          <div v-for="(h, i) in searchHits" :key="i" class="br-hit" @click="openHit(h)">
            <span class="br-hit-ver">{{ h.docVersion }}</span>
            <span class="br-hit-lang">{{ h.lang }}</span>
            <span class="br-hit-text">{{ h.snippet }}</span>
          </div>
        </div>
      </div>
      <button class="br-btn br-conflict-btn" @click="showConflicts = !showConflicts">
        {{ t('对齐冲突', 'Conflicts') }}
        <b v-if="data?.conflicts?.length" class="br-dot">{{ data.conflicts.length }}</b>
      </button>
    </div>

    <!-- Version/freshness banner: states what the translation is based on -->
    <div class="br-notice" :class="{ stale: !data?.summary?.inSync, ok: data?.summary?.inSync }">
      <strong>{{ t('翻译基线', 'Translation baseline') }}：</strong>{{ notice }}
      <span v-if="data?.sourceVersion" class="br-basis">
        {{ t('当前译文基于原文', 'Translation based on source') }}
        <code>{{ data.sourceVersion.version }}</code>
        <template v-if="data.latestSourceVersion !== data.sourceVersion.version">
          （{{ t('最新原文', 'latest') }} <code>{{ data.latestSourceVersion }}</code>）
        </template>
      </span>
      <span v-if="anchorInfo && anchorInfo.matchedBy !== 'stable-id'" class="br-anchor">
        {{ t('跨版本定位方式', 'anchor') }}: {{ anchorInfo.matchedBy }} ({{ Math.round(anchorInfo.confidence * 100) }}%)
      </span>
    </div>

    <!-- Lock vs graph comparison -->
    <div v-if="mode === 'lock' && lockComparison" class="br-lock-panel">
      <h4>{{ t('整篇语言锁 vs 段落级对齐图', 'Whole-document lock vs paragraph graph') }}</h4>
      <ul>
        <li>{{ t('锁基线', 'Lock baseline') }}: <code>{{ lockComparison.lockBaseline || '—' }}</code></li>
        <li>{{ t('当前原文', 'Current source') }}: <code>{{ lockComparison.currentSourceVersion }}</code></li>
        <li>{{ t('各边基线集合', 'Edge baselines') }}: {{ lockComparison.edgeBaselines.join(', ') || '—' }}</li>
        <li>{{ t('模式', 'Mode') }}: {{ lockComparison.graphMode }}
          <em v-if="lockComparison.graphMode === 'locked'">
            （{{ t('锁模式不允许部分同步：要么整篇对，要么整篇过期', 'lock forbids partial sync: all or stale') }}）</em>
        </li>
      </ul>
      <p :class="lockComparison.lockFullyConsistent ? 'br-green' : 'br-red'">{{ lockComparison.verdict }}</p>
    </div>

    <!-- Conflict panel: the human confirmation entry -->
    <div v-if="showConflicts" class="br-conflicts">
      <h4>{{ t('对齐冲突与人工确认', 'Alignment conflicts & manual confirmation') }}</h4>
      <p v-if="!data?.conflicts?.length">✅ {{ t('无冲突', 'none') }}</p>
      <table v-else>
        <thead><tr><th>{{ t('类型', 'code') }}</th><th>{{ t('位置', 'location') }}</th><th>{{ t('说明', 'message') }}</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in data.conflicts" :key="i" :class="'sev-' + c.severity">
            <td><code>{{ c.code }}</code></td>
            <td>{{ c.sourceId || c.targetId || c.key }}</td>
            <td>{{ c.message }}</td>
            <td>
              <button class="br-btn xs" @click="activeId = c.sourceId || c.targetId; scrollToActive()">
                {{ t('定位', 'locate') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="data?.openProposals?.length" class="br-proposals">
        <div v-for="p in data.openProposals" :key="p.id" class="br-proposal">
          <code>{{ p.type }}</code> {{ p.sourceId }} → {{ p.targetId }}
          <em>{{ t('提案人', 'by') }} {{ p.author }}：{{ p.reason }}</em>
          <button class="br-btn xs good" @click="approveProposal(p, 'approved')">{{ t('批准', 'approve') }}</button>
          <button class="br-btn xs bad" @click="approveProposal(p, 'rejected')">{{ t('驳回', 'reject') }}</button>
        </div>
      </div>
    </div>

    <!-- Two panes -->
    <div class="br-panes">
      <div ref="leftPane" class="br-pane br-left">
        <div class="br-pane-title">{{ t('原文（中文）', 'Source (中文)') }}
          <span class="br-pill">{{ data?.sourceVersion?.segments?.length || 0 }} {{ t('节点', 'nodes') }}</span>
        </div>
        <template v-for="row in rows" :key="row.seg.id">
          <div class="br-row" :class="{ active: activeId === row.seg.id }">
            <SegmentView :seg="row.seg" :state="row.state" :active="activeId === row.seg.id" lang="zh"
                         @select="selectNode(row)" />
            <!-- 1:N hint on the source side -->
            <span v-if="row.edges.length > 1" class="br-onen">
              1:{{ row.edges.length }} {{ t('对应右侧', 'targets') }}
            </span>
          </div>
        </template>
        <div v-if="orphanEdges.length" class="br-orphans">
          <h4>⚠️ {{ t('来源缺失的边（原文已删段）', 'Edges with missing source') }}</h4>
          <div v-for="e in orphanEdges" :key="e.id" class="br-orphan">
            <code>{{ e.sourceId }}</code> → <code>{{ e.targetId }}</code>
            <span class="br-state-badge" data-state="source-missing">source-missing</span>
          </div>
        </div>
      </div>

      <div ref="rightPane" class="br-pane br-right">
        <div class="br-pane-title">{{ t('译文', 'Translation') }} · {{ targetLang }}
          <span v-if="data?.targetAvailable === false" class="br-pill br-missing">
            {{ t('该语言暂缺', 'missing') }}
          </span>
        </div>

        <div v-if="data?.targetAvailable === false" class="br-missing-note">
          <p>🚧 {{ t('该语言版本尚未开始翻译。', 'Translation for this language has not started.') }}</p>
          <p>{{ t('页面不会回退到原文、也不宣称同步。', 'We neither fall back to the source text nor claim synchronization.') }}</p>
        </div>

        <template v-else>
          <template v-for="row in rows" :key="'r-' + row.seg.id">
            <div class="br-row" :class="{ active: activeId === row.seg.id }">
              <template v-if="!row.edges.length">
                <div class="br-placeholder untranslated">
                  <span>🫙 {{ t('暂无译文（未对齐）', 'no translation aligned') }}</span>
                </div>
              </template>
              <template v-for="(tg, j) in targetsFor(row)" :key="j">
                <div v-if="!tg.unit" class="br-placeholder target-missing">
                  <span>❌ {{ t('对齐目标缺失', 'target unit missing') }}: <code>{{ tg.edge.targetId }}</code></span>
                </div>
                <SegmentView v-else :seg="tg.unit" :state="tg.state"
                             :active="activeId === row.seg.id || activeId === tg.unit.id"
                             @select="selectedNode = { kind: 'target', row }; startReview(tg)" />
              </template>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- Review editor -->
    <div v-if="selectedNode?.reviewTarget || selectedNode?.row" class="br-editor">
      <h4>{{ t('审阅 / 人工确认', 'Review / confirm') }}</h4>
      <p v-if="selectedNode?.row">
        {{ t('选中节点', 'Selected') }}: <code>{{ selectedNode.row.seg.id }}</code>
        <span class="br-state-badge" :data-state="selectedNode.row.state">{{ selectedNode.row.state }}</span>
      </p>
      <textarea v-model="reviewDraft" :placeholder="t('修改译文（引用的参数名/代码不会被复制）…','Edit translation (refs stay linked)…')" rows="3" />
      <div class="br-actions">
        <button class="br-btn good" @click="submitVerification">✅ {{ t('验证通过（保存基线）', 'Verify & save baseline') }}</button>
        <button class="br-btn warn" @click="simulateOtherTranslator">
          👥 {{ t('模拟另一译者同时编辑此段', 'Simulate another translator') }}
        </button>
        <button class="br-btn" @click="selectedNode = null">{{ t('关闭', 'Close') }}</button>
      </div>
      <p v-if="selectedNode?.row?.state === 'code-ref-changed'" class="br-red">
        🔗 {{ t('引用的共享代码已更新（正文没有复制代码，所以只需重新确认引用）。',
                'Referenced shared code changed; confirm the reference again — no prose copy exists.') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.br-app { font-size: 14px; border: 1px solid var(--vp-cpx-border, #e2e2e6); border-radius: 10px; overflow: hidden; margin: 16px 0; }
.br-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 12px; background: var(--vp-c-bg-soft, #f6f6f8); border-bottom: 1px solid var(--vp-cpx-border, #e2e2e6); }
.br-group { display: flex; align-items: center; gap: 6px; }
.br-group label { font-size: 12px; opacity: .7; }
.br-search { position: relative; }
.br-hits { position: absolute; top: 34px; left: 0; right: 0; z-index: 20; background: var(--vp-c-bg, #fff); border: 1px solid #ccc; border-radius: 6px; max-height: 260px; overflow: auto; box-shadow: 0 4px 16px rgba(0,0,0,.12); }
.br-hit { padding: 6px 8px; cursor: pointer; display: flex; gap: 8px; font-size: 12px; }
.br-hit:hover { background: var(--vp-c-bg-soft, #f0f4ff); }
.br-hit-ver { font-weight: 700; color: #4080a0; }
.br-hit-lang { opacity: .6; }
.br-btn { border: 1px solid #c8c8d0; background: var(--vp-c-bg, #fff); border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.br-btn.active { border-color: #409eff; color: #409eff; }
.br-btn.good { border-color: #67c23a; color: #67c23a; }
.br-btn.bad { border-color: #f56c6c; color: #f56c6c; }
.br-btn.warn { border-color: #e6a23c; color: #e6a23c; }
.br-btn.xs { padding: 1px 6px; font-size: 11px; }
.br-conflict-btn { margin-left: auto; position: relative; }
.br-dot { background: #f56c6c; color: #fff; border-radius: 10px; padding: 0 6px; margin-left: 4px; }
.br-notice { padding: 8px 12px; font-size: 13px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.br-notice.stale { background: #fdf6ec; color: #8a5a10; border-bottom: 1px solid #f5dab1; }
.br-notice.ok { background: #f0f9eb; color: #3a7a1e; border-bottom: 1px solid #c2e7b0; }
.br-basis code, .br-anchor { background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; }
.br-anchor { font-size: 12px; }
.br-lock-panel, .br-conflicts, .br-editor { margin: 10px 12px; padding: 10px 12px; border: 1px solid #d9ecff; background: #f4f9ff; border-radius: 8px; }
.br-lock-panel ul { margin: 6px 0; padding-left: 18px; }
.br-red { color: #c45656; } .br-green { color: #3a7a1e; }
.br-conflicts table { width: 100%; border-collapse: collapse; font-size: 12px; }
.br-conflicts th, .br-conflicts td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
.sev-error td:first-child { color: #c45656; font-weight: 700; }
.br-proposal { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 12px; }
.br-panes { display: grid; grid-template-columns: 1fr 1fr; min-height: 480px; }
.br-pane { max-height: 640px; overflow-y: auto; padding: 10px 14px; scroll-behavior: auto; }
.br-left { border-right: 1px solid var(--vp-cpx-border, #e2e2e6); }
.br-pane-title { position: sticky; top: -10px; background: var(--vp-c-bg, #fff); padding: 4px 0 8px; font-weight: 700; z-index: 5; }
.br-pill { font-weight: 400; font-size: 11px; background: #eee; border-radius: 10px; padding: 1px 8px; margin-left: 6px; }
.br-pill.br-missing { background: #fde2e2; color: #c45656; }
.br-row { position: relative; margin: 4px 0; border-radius: 6px; }
.br-row.active { outline: 2px solid #409eff55; }
:deep(.br-segment) { position: relative; padding: 6px 8px; border-radius: 6px; cursor: pointer; line-height: 1.7; }
:deep(.br-segment.br-heading) { font-weight: 700; margin-top: 10px; }
:deep(.br-segment.br-active) { background: #ecf5ff; }
:deep(.br-code-body) { background: #1e1e2e; color: #d4d4dd; padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 4px 0; }
:deep(.br-code-head) { display: flex; gap: 8px; align-items: center; font-size: 12px; opacity: .85; }
:deep(.br-code-ver) { background: #409eff; color: #fff; border-radius: 8px; padding: 0 6px; }
:deep(.br-token.br-param) { background: #fdf6ec; color: #a06a10; padding: 0 5px; border-radius: 4px; border: 1px solid #f5dab1; }
:deep(.br-token.br-literal) { background: #f0f9eb; color: #3a7a1e; padding: 0 5px; border-radius: 4px; border: 1px solid #c2e7b0; }
.br-state-badge { float: right; font-size: 10px; border-radius: 8px; padding: 0 7px; margin-left: 6px; }
.br-state-badge[data-state="confirmed"] { background: #e1f3d8; color: #3a7a1e; }
.br-state-badge[data-state="needs-review"] { background: #faecd8; color: #9a6208; }
.br-state-badge[data-state="code-ref-changed"] { background: #e6f0fb; color: #2255aa; }
.br-state-badge[data-state="source-missing"], .br-state-badge[data-state="target-missing"] { background: #fde2e2; color: #c45656; }
.br-state-badge[data-state="untranslated"], .br-state-badge[data-state="translated"] { background: #eee; color: #666; }
.br-state-badge[data-state="stale-review"] { background: #fde2e2; color: #c45656; }
.br-onen { font-size: 10px; background: #409eff; color: #fff; border-radius: 8px; padding: 0 6px; position: absolute; right: 30px; top: 8px; }
.br-placeholder { padding: 8px 10px; border: 1px dashed #c0c4cc; border-radius: 6px; color: #909399; font-size: 12px; margin: 4px 0; }
.br-placeholder.target-missing { border-color: #f56c6c; color: #c45656; background: #fef0f0; }
.br-orphans { margin-top: 12px; padding: 8px; border: 1px dashed #f56c6c; border-radius: 8px; }
.br-orphan { font-size: 12px; margin: 4px 0; }
.br-missing-note { padding: 24px 12px; text-align: center; color: #909399; }
.br-editor textarea { width: 100%; box-sizing: border-box; border: 1px solid #c0c4cc; border-radius: 6px; padding: 8px; font: inherit; }
.br-actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
