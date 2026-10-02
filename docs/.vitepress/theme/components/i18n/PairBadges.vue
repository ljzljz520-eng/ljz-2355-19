<script setup>
import { STATUS_META } from './statusLabels.js'
defineProps({ reader: Object })
const emit = defineEmits(['edit'])
</script>

<template>
  <!-- 状态徽标：在每个已配对原文节点上指示基线版本/有效状态/关系基数/冲突 -->
  <div class="bi-badges" aria-hidden="false">
    <template v-for="p in reader.pairs || []" :key="`${p.srcNid}-${p.tgtNid}`">
      <span
        v-if="p.source"
        class="bi-badge"
        :class="STATUS_META[p.status.effective]?.cls"
        :data-badge-src="p.srcNid"
        :title="`基线 v${p.status.baselineVersion ?? '-'} · 关系 ${p.rel}${p.conflict ? ' · 冲突 ' + p.conflict : ''}`"
        @click="emit('edit', p)"
      >
        {{ STATUS_META[p.status.effective]?.icon }} {{ STATUS_META[p.status.effective]?.label }}
        <em v-if="p.rel !== '1:1'">·{{ p.rel }}</em>
      </span>
    </template>
  </div>
</template>
