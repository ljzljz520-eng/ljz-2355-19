// 种子脚本：解析 docs/ 中英文 Markdown → 语义段 → 显式语义对齐（非数组下标）→ 基线与审阅状态入库
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../server/db.js'
import * as repo from '../server/repo.js'
import { segmentMarkdown } from '../server/segmenter.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_FILE = process.env.DOC_DB ?? path.join(ROOT, 'server', 'docs.db')

// 显式语义对齐表：用内容片段定位 seg_key（['中文片段', '英文片段' 或 ['英文片段1','英文片段2']]）
// '#code:N' 表示第 N 个共享代码块（语言无关，按 code_ref 对齐）
const DOCS = [
  {
    id: 'guide/installation', title: '安装 / Installation',
    zh: 'docs/guide/installation.md', en: 'docs/en/guide/installation.md',
    align: [
      ['安装', 'Installation'],
      ['使用包管理器', 'Using Package Manager'],
      ['我们建议使用包管理器', 'We recommend installing'],
      ['#code:1', '#code:1'],
    ],
  },
  {
    id: 'guide/quickstart', title: '快速开始 / Quick Start',
    zh: 'docs/guide/quickstart.md', en: 'docs/en/guide/quickstart.md',
    align: [
      ['快速开始', 'Quick Start'],
      ['本节将介绍', 'This section will introduce'],
      ['引入组件', 'Import Components'],
      ['在你的 Vue 3 项目中', 'In your Vue 3 project'],
      ['全局引入', 'Global Import'],
      ['#code:1', '#code:1'],
      ['基础用法', 'Basic Usage'],
      ['::: demo', '::: demo'],
    ],
  },
  {
    id: 'components/button', title: 'Button 按钮',
    zh: 'docs/components/button.md', en: 'docs/en/components/button.md',
    align: [
      ['Button 按钮', 'Button'],
      ['常用的操作按钮', 'Commonly used operation buttons'],
      ['基础用法', 'Basic Usage'],
      ['基础的按钮用法', 'Basic button usage'],
      ['::: demo', '::: demo'],
      ['API', 'API'],
      ['Attributes', 'Attributes'],
      ['<VpApi', '<VpApi'],
    ],
  },
  {
    id: 'guide/telemetry', title: '遥测配置 / Telemetry',
    zh: 'server/seed-data/telemetry.zh.md', en: 'server/seed-data/telemetry.en.md',
    align: [
      ['遥测配置', 'Telemetry Configuration'],
      // 中文一段 ↔ 英文两段：一对多对齐，数组下标无法表达
      ['遥测功能默认关闭', ['Telemetry is disabled by default', 'Once enabled']],
      ['开启方式', 'How to Enable'],
      ['设置环境变量', 'Set the environment variable'],
      ['#code:1', '#code:1'],
      ['参数 `interval`', 'The `interval` parameter'],
    ],
  },
]

const findKey = (segs, matcher) => {
  if (matcher.startsWith('#code:')) {
    const hit = segs.find((s) => s.type === 'code' && s.key === `code:${matcher.replace('#code:', '')}`)
    if (!hit) throw new Error(`code block not found: ${matcher}`)
    return hit.key
  }
  // 优先精确匹配，其次前缀，最后子串（避免“全局引入”误中正文里的“…或全局引入组件。”）
  const candidates = segs.filter((s) => s.type !== 'code')
  const hit =
    candidates.find((s) => s.content === matcher) ??
    candidates.find((s) => s.content.startsWith(matcher)) ??
    candidates.find((s) => s.content.includes(matcher))
  if (!hit) throw new Error(`segment not found by content: ${matcher}`)
  return hit.key
}

export function seed(db, { demoDrift = true } = {}) {
  for (const d of DOCS) {
    db.prepare('INSERT OR REPLACE INTO documents (id, title, src_lang) VALUES (?,?,?)').run(d.id, d.title, 'zh')
    const zhBlocks = segmentMarkdown(fs.readFileSync(path.join(ROOT, d.zh), 'utf8'))
    const enBlocks = segmentMarkdown(fs.readFileSync(path.join(ROOT, d.en), 'utf8'))
    const zh = repo.publishVersion(db, { docId: d.id, lang: 'zh', blocks: zhBlocks, author: 'seed', note: 'import zh' })
    const en = repo.publishVersion(db, { docId: d.id, lang: 'en', blocks: enBlocks, author: 'seed', note: 'import en' })

    for (const [zhM, enM] of d.align) {
      const srcKey = findKey(zh.segments, zhM)
      const tgtKeys = (Array.isArray(enM) ? enM : [enM]).map((m) => findKey(en.segments, m))
      repo.setAlignment(db, { docId: d.id, srcKey, tgtLang: 'en', tgtKeys, confirmed: 1, by: 'seed' })
      for (const tgtKey of tgtKeys) repo.markVerified(db, { docId: d.id, tgtLang: 'en', tgtKey, translator: 'seed' })
    }
    repo.lockDocument(db, { docId: d.id, tgtLang: 'en', by: 'seed' })
    console.log(`seeded ${d.id}: zh v1 (${zh.segments.length} segs) / en v1 (${en.segments.length} segs), locked`)
  }

  if (demoDrift) {
    // 演示：原文 quickstart 修订一段 → 对应译段待复核，其余段保留已验，语言锁变 stale
    const zhNow = repo.getBilingual(db, { docId: 'guide/quickstart', tgtLang: 'en' })
    const blocks = zhNow.src.segments.map((s) => ({
      key: s.seg_key, type: s.seg_type, content: s.seg_type === 'code' ? '' : s.content, codeRef: s.code_ref ?? undefined,
    }))
    const intro = blocks.find((b) => b.content.includes('本节将介绍'))
    intro.content = '本节将介绍如何在 Vue 3 项目中安装并使用 My Component Lib 组件库。'
    repo.publishVersion(db, { docId: 'guide/quickstart', lang: 'zh', blocks, author: 'editor-zh', note: 'revise intro' })
    console.log('demo drift: guide/quickstart zh -> v2 (intro revised, translation needs review)')
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed.mjs')) {
  if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE)
  const db = openDb(DB_FILE)
  seed(db)
  console.log(`seed complete → ${DB_FILE}`)
}
