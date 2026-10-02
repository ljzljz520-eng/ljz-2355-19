<script setup>
import { computed, ref } from 'vue'
import { STATUS_META, CONFLICT_META } from './statusLabels.js'

const props = defineProps({
  reader: Object,
  actor: { type: String, default: 'reviewer' }
})
const emit = defineEmits(['decide-edge', 'manual-pair', 'review', 'retry'])

const tab = ref('conflicts')

// 需要人工处理的条目：对齐冲突 / 来源缺失 / 孤立边 / 待复核 stale
const conflicts = computed(() => {
  const d = props.reader.diagnostics || {}
  const items = []
  for (const a of d.ambiguous || []) items.push({ type: 'ambiguous', ...a })
  for (const m of d.missingSource || []) items.push({ type: 'missing-source', srcNid: m.ref, tgtNid: m.tgtNid })
  for (const o of d.orphaned || []) items.push({ type: 'orphaned', ...o })
  return items
})
const stalePairs = computed(() => props.reader.pairs.filter((p) => p.status.effective === 'stale'))
const unpaired = computed(() => {
  const d = props.reader.diagnostics || {}
  return [...(d.unmatchedSrc || []).map((x) => ({ side: 'source', nid: x.srcNid, kind: x.kind }))]
})

const pairByTgt = computed(() => Object.fromEntries(props.reader.pairs.map((p) => [p.tgtNid, p])))

const manualSrc = ref('')
const manualTgt = ref('')

function submitManual() {
  if (!manualSrc.value || !manualTgt.value) return
  emit('manual-pair', { srcNid: manualSrc.value, tgtNid: manualTgt.value })
  manualSrc.value = ''
  manualTgt.value = ''
}
function metaFor(type) {
  return { label: STATUS_META[type === 'missing-source' ? 'missing-source' : 'stale']?.label || type }
}
</script>

<template>
  <aside class="bi-review">
    <nav class="bi-tabs">
      <button :class="{ on: tab === 'conflicts' }" @click="tab = 'conflicts'">
        冲突与缺失 <b>{{ conflicts.length }}</b>
      </button>
      <button :class="{ on: tab === 'stale' }" @click="tab = 'stale'">
        待复核 <b>{{ stalePairs.length }}</b>
      </button>
      <button :class="{ on: tab === 'unpaired' }" @click="tab = 'unpaired'">
        未匹配 <b>{{ unpaired.length }}</b>
      </button>
    </nav>

    <div v-if="tab === 'conflicts'" class="bi-tabpane">
      <p v-if="!conflicts.length" class="bi-okline">没有对齐冲突或来源缺失。</p>
      <ul v-else class="bi-issues">
        <li v-for="(it, i) in conflicts" :key="i" class="bi-issue">
          <div class="bi-issue-type danger">{{ CONFLICT_META[it.type] || it.type }}</div>
          <div class="bi-issue-nodes">
            <code>{{ it.srcNid || '∅' }}</code>
            <span>↔</span>
            <code>{{ it.tgtNid || '∅' }}</code>
          </div>
          <div v-if="pairByTgt[it.tgtNid]" class="bi-issue-actions">
            <button class="bi-btn" @click="emit('decide-edge', { edgeId: pairByTgt[it.tgtNid].edgeId, decision: 'confirmed' })">
              确认对齐
            </button>
            <button class="bi-btn ghost danger" @click="emit('decide-edge', { edgeId: pairByTgt[it.tgtNid].edgeId, decision: 'rejected' })">
              否决
            </button>
          </div>
        </li>
      </ul>

      <div class="bi-manual">
        <div class="bi-manual-title">人工建立对应（来源缺失/重排补救）</div>
        <input v-model="manualSrc" placeholder="原文 nid，如 install-desc" />
        <input v-model="manualTgt" placeholder="译文 nid，如 en-install-desc" />
        <button class="bi-btn primary" @click="submitManual">建立并确认</button>
      </div>
    </div>

    <div v-else-if="tab === 'stale'" class="bi-tabpane">
      <p v-if="!stalePairs.length" class="bi-okline">所有译段都与当前原文一致。</p>
      <ul v-else class="bi-issues">
        <li v-for="p in stalePairs" :key="`${p.srcNid}-${p.tgtNid}`" class="bi-issue">
          <div class="bi-issue-type warn">
            ⟳ 基于原文 v{{ p.status.baselineVersion }}，原文已更新到 v{{ reader.srcVersion }}
          </div>
          <div class="bi-issue-nodes"><code>{{ p.srcNid }}</code><span>→</span><code>{{ p.tgtNid }}</code></div>
          <div class="bi-issue-actions">
            <button class="bi-btn primary" @click="emit('review', { pair: p, action: 'open' })">打开复核</button>
          </div>
        </li>
      </ul>
    </div>

    <div v-else class="bi-tabpane">
      <p v-if="!unpaired.length" class="bi-okline">没有悬空段落。</p>
      <ul v-else class="bi-issues">
        <li v-for="(u, i) in unpaired" :key="i" class="bi-issue">
          <div class="bi-issue-type">{{ u.side === 'source' ? '原文未匹配段落' : '译文未匹配段落' }}</div>
          <div class="bi-issue-nodes"><code>{{ u.nid }}</code></div>
        </li>
      </ul>
      <p class="bi-hint">未匹配段落不按序号猜测，请通过“人工建立对应”入口处理。</p>
    </div>
  </aside>
</template>
