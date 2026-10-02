<script setup>
import { ref, watch, computed } from 'vue'

const props = defineProps({
  pair: Object, // reader.pairs[i]
  reader: Object,
  actor: { type: String, default: 'translator' }
})
const emit = defineEmits(['close', 'saved', 'lock'])

const draft = ref('')
const saving = ref(false)
const errMsg = ref('')
const baseHash = ref(null)

watch(
  () => props.pair,
  (p) => {
    if (!p) return
    draft.value = p.target?.content || ''
    baseHash.value = null // 打开时以服务器当前版本为准
  },
  { immediate: true }
)

const stale = computed(() => props.pair?.status.effective === 'stale')
const missingTokens = computed(() => props.pair?.status.missingTokens || [])

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${res.status}`), { status: res.status, code: j.error?.code, details: j.error?.details })
  return j
}

async function save() {
  saving.value = true
  errMsg.value = ''
  try {
    const r = await api('/api/translations', {
      docId: props.reader.doc.id,
      srcLang: props.reader.srcLang,
      tgtLang: props.reader.tgtLang,
      srcNid: props.pair.srcNid,
      tgtNid: props.pair.tgtNid,
      content: draft.value,
      actor: props.actor,
      expectedContentHash: baseHash.value
    })
    emit('saved', r)
  } catch (e) {
    errMsg.value =
      e.code === 'translation-conflict'
        ? `冲突：该段已被其他译者修改（${e.message}）。请刷新后合并，旧内容不会被静默覆盖。`
        : e.code === 'language-locked' || e.code === 'segment-locked'
          ? `锁定中：${e.message}`
          : e.code === 'protected-token-missing'
            ? `受保护片段未原样保留：${(e.details?.missing || []).join(', ')}`
            : e.message
  } finally {
    saving.value = false
  }
}

async function verify() {
  await save()
  await api('/api/translations/review', {
    docId: props.reader.doc.id,
    srcLang: props.reader.srcLang,
    tgtLang: props.reader.tgtLang,
    srcNid: props.pair.srcNid,
    tgtNid: props.pair.tgtNid,
    status: 'verified',
    reviewer: props.actor
  })
  emit('saved')
}

async function lockSegment() {
  try {
    await api('/api/locks/segment', {
      docId: props.reader.doc.id,
      srcLang: props.reader.srcLang,
      tgtLang: props.reader.tgtLang,
      srcNid: props.pair.srcNid,
      tgtNid: props.pair.tgtNid,
      actor: props.actor
    })
    emit('lock')
  } catch (e) {
    errMsg.value = e.message
  }
}
</script>

<template>
  <div v-if="pair" class="bi-modal-mask" @click.self="emit('close')">
    <div class="bi-modal">
      <header>
        <strong>翻译段落</strong>
        <code class="bi-modal-nid">{{ pair.srcNid }} → {{ pair.tgtNid }}</code>
        <button class="bi-x" @click="emit('close')">×</button>
      </header>
      <div class="bi-modal-body">
        <div class="bi-src-view">
          <span class="bi-tag">原文 v{{ reader.srcVersion }}</span>
          <pre>{{ pair.source?.content }}</pre>
        </div>
        <div v-if="stale" class="bi-banner warn">
          ⟳ 该译文基于原文 v{{ pair.status.baselineVersion }}，原文当前为 v{{ reader.srcVersion }}。
          复核后再标记已验证。
        </div>
        <div v-if="pair.source?.code" class="bi-banner info">
          代码为共享引用（codeRef: <code>{{ pair.source.codeRef }}</code>），正文不复制代码；保持参数名一致即可。
        </div>
        <textarea v-model="draft" rows="8" class="bi-draft"></textarea>
        <ul v-if="missingTokens.length" class="bi-tokens-warn">
          <li v-for="t in missingTokens" :key="t">当前译文缺少受保护引用 <code>{{ t }}</code></li>
        </ul>
        <p v-if="errMsg" class="bi-error">{{ errMsg }}</p>
      </div>
      <footer>
        <button class="bi-btn ghost" @click="lockSegment">占用段落锁</button>
        <span class="bi-spacer"></span>
        <button class="bi-btn" :disabled="saving" @click="save">保存草稿</button>
        <button class="bi-btn primary" :disabled="saving" @click="verify">复核通过</button>
      </footer>
    </div>
  </div>
</template>
