// Fixture: /components/tag
// English is temporarily missing ("某语言暂缺"). The API returns 200 with
// targetAvailable:false and a reason, so the UI renders an explicit empty
// pane + notice instead of 404 or a misleading "in sync" view.

const t = (text) => [{ kind: 'text', text }]
const heading = (id, text) => ({ id, type: 'heading', text })

const v100 = {
  version: '1.0.0',
  createdAt: '2026-09-10',
  segments: [
    heading('h-tag', '标签'),
    { id: 'p-tag-intro', tokens: t('Tag 用于标记和选择。') }
  ]
}

export const tagDoc = {
  id: 'components/tag',
  title: { zh: 'Tag 标签', en: 'Tag' },
  sourceLang: 'zh',
  languages: ['zh', 'en'], // en declared, but no en units exist
  versions: [v100],
  units: [],
  edgesByVersion: { '1.0.0': [] },
  missingReason: { en: 'translation-not-started' }
}
