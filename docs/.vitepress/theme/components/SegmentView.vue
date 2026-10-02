<script setup>
// Renders one semantic node (heading / prose / code-ref) resolving shared
// references live from the registry. Translation prose never contains code
// copies — code/param/literal tokens are references rendered identically.
import { computed } from 'vue'
import { resolveRef } from '../i18n/readerStore.js'

const props = defineProps({
  seg: { type: Object, required: true },
  state: { type: String, default: '' },
  active: { type: Boolean, default: false },
  lang: { type: String, default: 'zh' }
})
const emit = defineEmits(['select'])

const isHeading = computed(() => props.seg.type === 'heading')
const isCodeRef = computed(() => props.seg.type === 'code-ref')
const code = computed(() => (isCodeRef.value ? resolveRef(props.seg.ref) : null))

const tokenHtml = (tok) => {
  if (typeof tok === 'string') return escapeHtml(tok)
  if (tok.kind === 'text') return escapeHtml(tok.text)
  if (tok.kind === 'param') {
    const r = resolveRef(tok.ref)
    return `<code class="br-token br-param" title="参数名 · parameter name (do not translate)">${escapeHtml(r?.name || tok.ref)}</code>`
  }
  if (tok.kind === 'literal') {
    const r = resolveRef(tok.ref)
    return `<code class="br-token br-literal" title="不可翻译 · do not translate">🔒 ${escapeHtml(r?.text || tok.ref)}</code>`
  }
  return ''
}

const html = computed(() => (props.seg.tokens || []).map(tokenHtml).join(''))

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
</script>

<template>
  <component
    :is="isHeading ? (seg.text && seg.text.length > 6 ? 'h3' : 'h4') : 'div'"
    class="br-segment"
    :class="['is-' + (state || 'none'), { 'br-active': active, 'br-heading': isHeading, 'br-code': isCodeRef }]"
    :data-segment-id="seg.id"
    @click="emit('select', seg.id)"
  >
    <template v-if="isHeading">{{ seg.text }}</template>
    <template v-else-if="isCodeRef && code">
      <div class="br-code-head">
        <span class="br-lock">🔗 共享示例 · shared example</span>
        <code>{{ code.filename }}</code>
        <span class="br-code-ver">v{{ code.version || seg.resolvedVersion }}</span>
      </div>
      <pre class="br-code-body"><code>{{ code.body }}</code></pre>
    </template>
    <template v-else><span v-html="html" /></template>
    <span v-if="state" class="br-state-badge" :data-state="state">{{ state }}</span>
  </component>
</template>
