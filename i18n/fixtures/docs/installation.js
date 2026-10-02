// Fixture: /guide/installation
// This doc uses a WHOLE-DOCUMENT LANGUAGE LOCK: English is certified against
// source 1.0.0 only. The source has since shipped 1.1.0. The reader must show
// "English translated against 1.0.0; source is now 1.1.0" — it must NOT claim
// the panes are fully in sync. lockVsGraph exposes exactly this comparison.

const t = (text) => [{ kind: 'text', text }]
const heading = (id, text) => ({ id, type: 'heading', text })

const v100 = {
  version: '1.0.0',
  createdAt: '2026-08-01',
  segments: [
    heading('h-install', '安装'),
    { id: 'p-install', tokens: t('运行 npm install my-component-lib 安装。') }
  ]
}
const v110 = {
  version: '1.1.0',
  createdAt: '2026-09-20',
  note: '包管理器说明更新',
  segments: [
    heading('h-install', '安装'),
    { id: 'p-install', tokens: t('运行 npm install my-component-lib 安装；也可使用 pnpm 或 yarn。') }
  ]
}

const enUnits = [
  { id: 'h-install', lang: 'en', type: 'heading', text: 'Installation' },
  { id: 'p-install', lang: 'en', tokens: t('Run npm install my-component-lib to install.') }
]

export const installationDoc = {
  id: 'guide/installation',
  title: { zh: '安装', en: 'Installation' },
  sourceLang: 'zh',
  languages: ['zh', 'en'],
  versions: [v100, v110],
  units: enUnits,
  edgesByVersion: {
    '1.0.0': [
      { sourceId: 'h-install', targetId: 'h-install', kind: 'one-to-one' },
      { sourceId: 'p-install', targetId: 'p-install', kind: 'one-to-one' }
    ],
    // no fresh edges for 1.1.0: translator has not realigned
    '1.1.0': []
  },
  // whole-document lock, pinned to the OLD source baseline
  lock: {
    en: { docVersion: '1.0.0', certifiedBy: 'reviewer-a', certifiedAt: '2026-08-05' }
  },
  missingReason: {}
}
