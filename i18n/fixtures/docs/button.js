// Fixture: /components/button
// Version history deliberately exercises every edge case:
//   1.0.0 -> 1.1.0  chapter reorder, one Chinese paragraph maps to TWO English
//                    paragraphs (1:N), shared code updated v1->v2, one
//                    paragraph removed, one added, a do-not-translate line
//   1.1.0 -> 1.2.0  tiny edit to ONE paragraph only (proves unchanged
//                    paragraphs keep their verified status)

const t = (text) => [{ kind: 'text', text }]
const heading = (id, text) => ({ id, type: 'heading', text })

const v100 = {
  version: '1.0.0',
  createdAt: '2026-08-01',
  note: '初始版本',
  segments: [
    heading('h-usage', '基础用法'),
    { id: 'p-intro', tokens: t('Button 组件用于触发一个操作。') },
    { id: 'p-basic-desc', tokens: t('点击按钮触发点击事件。') },
    { id: 'c-demo-button', type: 'code-ref', ref: 'code:demo-button' },
    heading('h-install', '安装'),
    // one Chinese paragraph that English splits into TWO (1:N)
    { id: 'p-install-1', tokens: t('使用 npm 安装，然后在入口引入。') },
    heading('h-api', 'API'),
    { id: 'p-api', tokens: [
      { kind: 'text', text: '通过 ' },
      { kind: 'param', ref: 'param:type' },
      { kind: 'text', text: ' 属性指定按钮类型。' }
    ] },
    // legacy note removed in 1.1.0 (drives the source-missing edge)
    heading('h-legacy', '旧版提示'),
    { id: 'p-legacy', tokens: t('0.x 版本的 size 行为不同。') }
  ]
}

const v110 = {
  version: '1.1.0',
  createdAt: '2026-09-15',
  note: '章节重排；示例代码更新；删除旧版提示',
  segments: [
    // installation section moved BEFORE usage (chapter reorder)
    heading('h-install', '安装'),
    // paragraph edited (wording change flips baseline)
    { id: 'p-install-1', tokens: t('推荐使用 npm 安装，并在应用入口中引入。') },
    heading('h-usage', '基础用法'),
    { id: 'p-intro', tokens: t('Button 组件用于触发一个操作，支持多种类型。') },
    { id: 'p-basic-desc', tokens: t('点击按钮触发点击事件；也可设置禁用态。') },
    { id: 'c-demo-button', type: 'code-ref', ref: 'code:demo-button' }, // registry now v2
    // new do-not-translate paragraph
    { id: 'p-dnt-new', tokens: [
      { kind: 'text', text: '入口函数名为 ' },
      { kind: 'literal', ref: 'lit:createApp' },
      { kind: 'text', text: '，请勿翻译。' }
    ] },
    heading('h-api', 'API'),
    { id: 'p-api', tokens: [
      { kind: 'text', text: '通过 ' },
      { kind: 'param', ref: 'param:type' },
      { kind: 'text', text: ' 属性指定按钮类型；' },
      { kind: 'param', ref: 'param:size' },
      { kind: 'text', text: ' 控制尺寸。' }
    ] },
    // brand-new paragraph, translation not started
    { id: 'p-perf', tokens: t('大量按钮场景下建议使用虚拟滚动。') }
  ]
}

const v120 = {
  version: '1.2.0',
  createdAt: '2026-09-28',
  note: '仅修正一处措辞',
  segments: [
    heading('h-install', '安装'),
    // ONLY this paragraph is edited vs 1.1.0:
    { id: 'p-install-1', tokens: t('推荐使用 npm 安装，并在应用入口中引入组件。') },
    heading('h-usage', '基础用法'),
    { id: 'p-intro', tokens: t('Button 组件用于触发一个操作，支持多种类型。') },
    { id: 'p-basic-desc', tokens: t('点击按钮触发点击事件；也可设置禁用态。') },
    { id: 'c-demo-button', type: 'code-ref', ref: 'code:demo-button' },
    { id: 'p-dnt-new', tokens: [
      { kind: 'text', text: '入口函数名为 ' },
      { kind: 'literal', ref: 'lit:createApp' },
      { kind: 'text', text: '，请勿翻译。' }
    ] },
    heading('h-api', 'API'),
    { id: 'p-api', tokens: [
      { kind: 'text', text: '通过 ' },
      { kind: 'param', ref: 'param:type' },
      { kind: 'text', text: ' 属性指定按钮类型；' },
      { kind: 'param', ref: 'param:size' },
      { kind: 'text', text: ' 控制尺寸。' }
    ] },
    { id: 'p-perf', tokens: t('大量按钮场景下建议使用虚拟滚动。') }
  ]
}

// ---- English translation units -------------------------------------------
const en100 = [
  { id: 'h-usage', lang: 'en', type: 'heading', text: 'Basic Usage' },
  { id: 'p-intro', lang: 'en', tokens: t('Use the Button component to trigger an action.') },
  { id: 'p-basic-desc', lang: 'en', tokens: t('Click the button to fire the click event.') },
  { id: 'c-demo-button', lang: 'en', type: 'code-ref', ref: 'code:demo-button' },
  { id: 'h-install', lang: 'en', type: 'heading', text: 'Installation' },
  // Chinese p-install-1 (one paragraph) -> these TWO English paragraphs (1:N)
  { id: 'p-install-1', lang: 'en', tokens: t('Install it with npm.') },
  { id: 'p-install-2', lang: 'en', tokens: t('Then import it in your entry file.') },
  { id: 'h-api', lang: 'en', type: 'heading', text: 'API' },
  { id: 'p-api', lang: 'en', tokens: [
    { kind: 'text', text: 'Use the ' },
    { kind: 'param', ref: 'param:type' },
    { kind: 'text', text: ' prop to set the button type.' }
  ] },
  { id: 'h-legacy', lang: 'en', type: 'heading', text: 'Legacy Notice' },
  { id: 'p-legacy', lang: 'en', tokens: t('The size behaviour differed in 0.x.') }
]

const en110 = [
  ...en100.filter((u) => u.id !== 'h-legacy' && u.id !== 'p-legacy'),
  { id: 'p-dnt-new', lang: 'en', tokens: [
    { kind: 'text', text: 'The entry function is named ' },
    { kind: 'literal', ref: 'lit:createApp' },
    { kind: 'text', text: '; do not translate it.' }
  ] },
  { id: 'p-perf-early', lang: 'en', tokens: t('Preview note about performance.') }
]

// ---- Explicit alignment edges per SOURCE version (never array indexes!) ---
const edgesByVersion = {
  '1.0.0': [
    { sourceId: 'h-usage', targetId: 'h-usage', kind: 'one-to-one' },
    { sourceId: 'p-intro', targetId: 'p-intro', kind: 'one-to-one' },
    { sourceId: 'p-basic-desc', targetId: 'p-basic-desc', kind: 'one-to-one' },
    { sourceId: 'c-demo-button', targetId: 'c-demo-button', kind: 'one-to-one' },
    { sourceId: 'h-install', targetId: 'h-install', kind: 'one-to-one' },
    // explicit 1:N group — this is why array-index alignment is forbidden
    { sourceId: 'p-install-1', targetId: 'p-install-1', kind: 'one-to-many', group: 'g-install' },
    { sourceId: 'p-install-1', targetId: 'p-install-2', kind: 'one-to-many', group: 'g-install' },
    { sourceId: 'h-api', targetId: 'h-api', kind: 'one-to-one' },
    { sourceId: 'p-api', targetId: 'p-api', kind: 'one-to-one' },
    { sourceId: 'h-legacy', targetId: 'h-legacy', kind: 'one-to-one' },
    { sourceId: 'p-legacy', targetId: 'p-legacy', kind: 'one-to-one' }
  ],
  '1.1.0': [
    { sourceId: 'h-install', targetId: 'h-install', kind: 'one-to-one' },
    { sourceId: 'p-install-1', targetId: 'p-install-1', kind: 'one-to-many', group: 'g-install-110' },
    { sourceId: 'p-install-1', targetId: 'p-install-2', kind: 'one-to-many', group: 'g-install-110' },
    { sourceId: 'h-usage', targetId: 'h-usage', kind: 'one-to-one' },
    { sourceId: 'p-intro', targetId: 'p-intro', kind: 'one-to-one' },
    { sourceId: 'p-basic-desc', targetId: 'p-basic-desc', kind: 'one-to-one' },
    { sourceId: 'c-demo-button', targetId: 'c-demo-button', kind: 'one-to-one' },
    { sourceId: 'p-dnt-new', targetId: 'p-dnt-new', kind: 'one-to-one' },
    { sourceId: 'h-api', targetId: 'h-api', kind: 'one-to-one' },
    { sourceId: 'p-api', targetId: 'p-api', kind: 'one-to-one' },
    { sourceId: 'p-perf', targetId: 'p-perf-early', kind: 'one-to-one' },
    // ---- deliberate alignment defects for conflict detection ----
    // source-missing: legacy paragraph was deleted in 1.1.0, edge still here
    { sourceId: 'p-legacy', targetId: 'p-legacy', kind: 'one-to-one' },
    // target-missing: English unit p-ghost was never authored
    { sourceId: 'p-basic-desc', targetId: 'p-ghost', kind: 'one-to-one' },
    // duplicate-target: English p-api claimed by a second source paragraph
    { sourceId: 'p-dnt-new', targetId: 'p-api', kind: 'one-to-one' }
  ],
  '1.2.0': [
    { sourceId: 'h-install', targetId: 'h-install', kind: 'one-to-one' },
    { sourceId: 'p-install-1', targetId: 'p-install-1', kind: 'one-to-many', group: 'g-install-120' },
    { sourceId: 'p-install-1', targetId: 'p-install-2', kind: 'one-to-many', group: 'g-install-120' },
    { sourceId: 'h-usage', targetId: 'h-usage', kind: 'one-to-one' },
    { sourceId: 'p-intro', targetId: 'p-intro', kind: 'one-to-one' },
    { sourceId: 'p-basic-desc', targetId: 'p-basic-desc', kind: 'one-to-one' },
    { sourceId: 'c-demo-button', targetId: 'c-demo-button', kind: 'one-to-one' },
    { sourceId: 'p-dnt-new', targetId: 'p-dnt-new', kind: 'one-to-one' },
    { sourceId: 'h-api', targetId: 'h-api', kind: 'one-to-one' },
    { sourceId: 'p-api', targetId: 'p-api', kind: 'one-to-one' }
    // p-perf intentionally has no edge -> untranslated
  ]
}

export const buttonDoc = {
  id: 'components/button',
  title: { zh: 'Button 按钮', en: 'Button' },
  sourceLang: 'zh',
  languages: ['zh', 'en'],
  versions: [v100, v110, v120],
  units: [...new Map([...en100, ...en110].map((u) => [`${u.lang}:${u.id}`, u])).values()],
  edgesByVersion,
  missingReason: {}
}
