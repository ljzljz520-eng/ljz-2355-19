<script setup>
import { computed, onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue'
import { useReaderData, searchI18n } from './useReaderData.js'
import { buildPairIndex, useSyncedScroll } from './useSyncedScroll.js'
import PairColumn from './PairColumn.vue'
import ReviewPanel from './ReviewPanel.vue'
import TranslateEditor from './TranslateEditor.vue'

const props = defineProps({
  docId: { type: String, required: true },
  srcLang: { type: String, default: 'zh' },
  tgtLang: { type: String, default: 'en' },
  initialSrcVersion: { type: Number, default: null },
  anchorNid: { type: String, default: null },
  actor: { type: String, default: 'translator-a' }
})

const { data: reader, loading, error, source, load } = useReaderData(props.docId)
const leftCol = ref(null)
const rightCol = ref(null)
const activeSrc = ref(null)
const activeTgt = ref(null)
const editingPair = ref(null)
const lockInfo = ref(null)
const bannerMsg = ref('')
const searchQ = ref('')
const searchHits = ref([])
const showReview = ref(true)
const selectedSrcVer = ref(props.initialSrcVersion)
const versionsList = ref([])
const snapshotVersions = ref([])

const query = computed(() => ({
  srcLang: props.srcLang,
  tgtLang: props.tgtLang,
  srcVersion: selectedSrcVer.value
}))

const index = computed(() =>
  reader.value ? buildPairIndex(reader.value.pairs) : { src2tgt: new Map(), tgt2src: new Map() }
)
const ordered = computed(() => ({
  src: (reader.value?.columns.source || []).map((b) => b.nid),
  tgt: (reader.value?.columns.target || []).map((b) => b.nid)
}))
const srcMap = computed(() => Object.fromEntries((reader.value?.pairs || []).map((p) => [p.srcNid, p])))
const tgtMap = computed(() => Object.fromEntries((reader.value?.pairs || []).map((p) => [p.tgtNid, p])))

const scrollBody = (side) =>
  side === 'left'
    ? leftCol.value?.$el?.querySelector('.bi-col-body')
    : rightCol.value?.$el?.querySelector('.bi-col-body')

const { bind, unbind, restoreAnchor } = useSyncedScroll(
  () => ({ left: scrollBody('left'), right: scrollBody('right') }),
  index,
  ordered
)

onMounted(async () => {
  await load(query.value)
  await nextTick()
  bind(scrollBody('left'), scrollBody('right'))
  if (props.anchorNid) restoreAnchor(props.srcLang, props.anchorNid)
  loadVersions()
})
onBeforeUnmount(() => unbind(scrollBody('left'), scrollBody('right')))
watch(selectedSrcVer, async () => {
  await load(query.value)
  await nextTick()
})

async function loadVersions() {
  // 快照随构建产出 versions.json（含 API 不可用时的可用历史版本）
  try {
    const res = await fetch(`/i18n/${encodeURIComponent(props.docId)}/versions.json`)
    if (res.ok) {
      const j = await res.json()
      versionsList.value = j.versions || []
      snapshotVersions.value = j.snapshotVersions || []
    }
  } catch {}
}
const zhVersions = computed(() => {
  const apiVs = versionsList.value.filter((v) => v.lang === props.srcLang).map((v) => v.version)
  return [...new Set([...apiVs, ...(source.value === 'snapshot' ? snapshotVersions.value : [])])].sort((a, b) => a - b)
})
const isHistory = computed(() => reader.value && !reader.value.srcIsLatest)
const baselineSummary = computed(() => {
  if (!reader.value) return ''
  const label = { verified: '已验证', stale: '待复核', untranslated: '未翻译', 'missing-source': '来源缺失' }
  return Object.entries(reader.value.counts || {})
    .filter(([, n]) => n)
    .map(([k, n]) => `${label[k] || k} ${n}`)
    .join(' · ')
})

function onPickSrc(nid, pair) {
  activeSrc.value = nid
  activeTgt.value = pair?.target?.nid || null
  if (pair?.target) scrollPeer('right', pair.target.nid)
}
function onPickTgt(nid, pair) {
  activeTgt.value = nid
  activeSrc.value = pair?.source?.nid || null
  if (pair?.source) scrollPeer('left', pair.source.nid)
}
function scrollPeer(side, nid) {
  const col = scrollBody(side === 'right' ? 'right' : 'left')
  const el = col?.querySelector(`[data-nid="${CSS.escape(nid)}"]`)
  if (el) col.scrollTo({ top: el.offsetTop - col.clientHeight * 0.2, behavior: 'smooth' })
}

async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${res.status}`), { code: j.error?.code })
  return j
}
async function acquireLanguageLock() {
  try {
    lockInfo.value = await api('/api/locks', { docId: props.docId, lang: props.tgtLang, actor: props.actor, ttl: 600 })
    bannerMsg.value = `已获取整篇语言锁（${props.tgtLang}）；其他译者的保存将被拒绝，直到释放或过期。`
  } catch (e) {
    bannerMsg.value = e.message
  }
}
async function releaseLanguageLock() {
  await api('/api/locks', { docId: props.docId, lang: props.tgtLang, actor: props.actor }, 'DELETE')
  lockInfo.value = null
  bannerMsg.value = '已释放整篇语言锁；当前回到段落级对齐图的细粒度协作模式。'
}
async function onDecide({ edgeId, decision }) {
  await api(`/api/edges/${edgeId}/decision`, { decision, actor: props.actor })
  await load(query.value)
}
async function onManual({ srcNid, tgtNid }) {
  await api('/api/edges/manual', { docId: props.docId, srcLang: props.srcLang, tgtLang: props.tgtLang, srcNid, tgtNid, actor: props.actor })
  bannerMsg.value = '人工对应已建立并确认。'
  await load(query.value)
}
async function onSaved() {
  editingPair.value = null
  await load(query.value)
  bannerMsg.value = '已保存；审阅状态已按当前原文版本重新计算。'
}
async function doSearch() {
  if (!searchQ.value.trim()) return (searchHits.value = [])
  try {
    searchHits.value = (await searchI18n(searchQ.value, props.srcLang, selectedSrcVer.value, props.docId)).hits
  } catch {
    bannerMsg.value = '历史搜索需要内容 API 运行（当前为只读快照）。'
  }
}
function jumpHit(h) {
  selectedSrcVer.value = h.version
  nextTick(() => restoreAnchor(props.srcLang, h.nid))
}
</script>

<template>
  <div class="bi-app">
    <div class="bi-header">
      <div class="bi-title-row">
        <h2>{{ reader?.doc.title || docId }}</h2>
        <span class="bi-source-tag" :class="source">{{ source === 'api' ? '实时内容 API' : '构建期快照（只读）' }}</span>
      </div>

      <template v-if="reader">
        <div class="bi-meta-row">
          <label class="bi-ver">
            原文版本
            <select v-model.number="selectedSrcVer">
              <option v-for="v in zhVersions" :key="v" :value="v">v{{ v }}</option>
            </select>
            <span v-if="reader.srcVersion !== reader.srcCurrentVersion" class="bi-history-flag">
              历史 v{{ reader.srcVersion }} · 当前 v{{ reader.srcCurrentVersion }}
            </span>
            <span v-else class="bi-latest-flag">最新原文 v{{ reader.srcCurrentVersion }}</span>
          </label>
          <span class="bi-counts">{{ baselineSummary }}</span>
          <span class="bi-spacer"></span>
          <button class="bi-btn ghost" @click="showReview = !showReview">{{ showReview ? '隐藏审阅' : '审阅面板' }}</button>
          <button v-if="!lockInfo" class="bi-btn" @click="acquireLanguageLock">整篇语言锁</button>
          <button v-else class="bi-btn primary" @click="releaseLanguageLock">释放语言锁</button>
        </div>

        <div v-if="isHistory" class="bi-banner warn">
          当前阅读 <b>历史原文 v{{ reader.srcVersion }}</b>。译文按其保存基线展示，可能已过期——
          页面不会把过期译文呈现为与最新原文完全同步。
        </div>
        <div v-if="reader.targetMissing" class="bi-banner danger">
          目标语言 <b>{{ reader.tgtLang }}</b> 暂缺：右栏为空，不做下标式伪对齐，等待翻译版本摄入。
        </div>

        <form class="bi-search" @submit.prevent="doSearch">
          <input v-model="searchQ" placeholder="搜索并定位（可进入历史版本的语义节点）" />
          <button class="bi-btn">搜索</button>
          <ul v-if="searchHits.length" class="bi-hits">
            <li v-for="(h, i) in searchHits" :key="i" @click="jumpHit(h)">
              <b>v{{ h.version }}</b> · {{ h.snippet }}
            </li>
          </ul>
        </form>
        <p v-if="bannerMsg" class="bi-flash">{{ bannerMsg }}</p>
      </template>
    </div>

    <div v-if="loading" class="bi-loading">加载语义对齐数据…</div>
    <div v-else-if="error" class="bi-banner danger">加载失败：{{ error.message }}</div>

    <div v-else-if="reader" class="bi-body" :class="{ 'with-review': showReview }">
      <div class="bi-columns">
        <PairColumn
          ref="leftCol"
          title="原文"
          :lang="reader.srcLang"
          :nodes="reader.columns.source"
          :nid-map="srcMap"
          :active-nid="activeSrc"
          side="source"
          @pick="onPickSrc"
          @edit="(p) => (editingPair = p)"
          @scroll="() => {}"
        />
        <PairColumn
          ref="rightCol"
          title="译文"
          :lang="reader.tgtLang"
          :nodes="reader.columns.target"
          :nid-map="tgtMap"
          :active-nid="activeTgt"
          side="target"
          @pick="onPickTgt"
          @edit="(p) => (editingPair = p)"
          @scroll="() => {}"
        />
      </div>

      <ReviewPanel
        v-if="showReview"
        :reader="reader"
        :actor="actor"
        @decide-edge="onDecide"
        @manual-pair="onManual"
        @review="(x) => (editingPair = x.pair)"
      />
    </div>

    <TranslateEditor v-if="editingPair" :pair="editingPair" :reader="reader" :actor="actor" @close="editingPair = null" @saved="onSaved" />
  </div>
</template>
