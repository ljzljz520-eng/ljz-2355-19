<script setup>
import { computed } from 'vue'
import { renderBlock } from './markdown.js'
import { STATUS_META } from './statusLabels.js'

const props = defineProps({
  title: String,
  lang: String,
  nodes: { type: Array, default: () => [] },
  nidMap: { type: Object, default: () => ({}) }, // 当前列 nid -> pair
  activeNid: String,
  side: String // 'source' | 'target'
})
const emit = defineEmits(['pick', 'edit', 'scroll'])

const rows = computed(() =>
  props.nodes.map((node) => {
    const pair = props.nidMap[node.nid] || null
    const status = pair ? STATUS_META[pair.status.effective] : null
    return {
      node,
      pair,
      status,
      html: renderBlock(node),
      active: props.activeNid === node.nid
    }
  })
)
</script>

<template>
  <section class="bi-col" :data-lang="lang">
    <header class="bi-col-head">
      <span class="bi-col-title">{{ title }}</span>
      <span class="bi-col-lang">{{ lang }}</span>
    </header>
    <div class="bi-col-body" @scroll="emit('scroll', $event)">
      <article
        v-for="row in rows"
        :key="row.node.nid"
        class="bi-node"
        :class="[
          `bi-kind-${row.node.kind}`,
          { 'is-active': row.active, 'is-paired': !!row.pair, 'is-unpaired': !row.pair }
        ]"
        :data-nid="row.node.nid"
        @click="emit('pick', row.node.nid, row.pair)"
      >
        <span
          v-if="row.status && row.pair.source && row.pair.target"
          class="bi-badge"
          :class="row.status.cls"
          @click.stop="emit('edit', row.pair)"
        >
          {{ row.status.icon }} {{ row.status.label }}
          <em v-if="row.pair.rel !== '1:1'">·{{ row.pair.rel }}</em>
        </span>
        <span class="bi-node-html" v-html="row.html"></span>
      </article>
      <p v-if="!nodes.length" class="bi-col-empty">该语言版本暂缺</p>
    </div>
  </section>
</template>
