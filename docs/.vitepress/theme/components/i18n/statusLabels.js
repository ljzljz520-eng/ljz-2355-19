export const STATUS_META = {
  verified: { label: '已验证', cls: 'ok', icon: '✓' },
  stale: { label: '待复核 · 原文已更新', cls: 'warn', icon: '⟳' },
  in_review: { label: '审阅中', cls: 'review', icon: '…' },
  draft: { label: '草稿', cls: 'draft', icon: '✎' },
  untranslated: { label: '未翻译', cls: 'missing', icon: '+' },
  'missing-source': { label: '来源缺失', cls: 'danger', icon: '!' }
}

export const CONFLICT_META = {
  ambiguous: '对齐冲突：拆段与合并交叉，需人工确认',
  'missing-source': '来源缺失：译文引用的原文节点不存在',
  orphaned: '孤立译段：当前原文版本中对应节点已消失'
}
