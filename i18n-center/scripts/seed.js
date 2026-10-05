import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetDb, openDb } from '../src/db/index.js'
import { publishVersion, bootstrapUnits } from '../src/content/version.js'
import { autoAlign, setManualAlignment } from '../src/align/align.js'
import { saveUnit, submitUnit, verifyUnit } from '../src/content/units.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '../data')

// ---------- 《安装指南》v1 ----------
const installZhV1 = `# 安装指南

## 前置条件

<!-- node:prereq -->安装前请准备 {{runtime}} 18 以上。

## 使用包管理器

<!-- node:pkg-intro -->我们建议使用 \`npm\`、\`pnpm\` 或 \`yarn\` 安装 {{组件名}}。

- Node.js 环境
- 包管理器可用

<!-- node:install-cmd -->执行安装命令：

\`\`\`bash
npm install my-lib
\`\`\`
`

const installEnV1 = `# Installation Guide

## Prerequisites

<!-- node:prereq -->Prepare {{runtime}} 18 or above before installing.

## Using a Package Manager

<!-- node:pkg-intro -->We recommend installing {{组件名}} with \`npm\`, \`pnpm\` or \`yarn\`.

- Node.js environment
- A working package manager

<!-- node:install-cmd -->Run the install command:

\`\`\`bash
npm install my-lib
\`\`\`
`

// ---------- 《安装指南》v2（中文）：章节重排（命令提前）、原文改写、代码更新 ----------
const installZhV2 = `# 安装指南

## 快速安装

<!-- node:install-cmd -->执行安装命令（推荐 \`npm ci\`）：

\`\`\`bash
npm ci my-lib
\`\`\`

## 前置条件

<!-- node:prereq -->安装前请准备 {{runtime}} 20 以上，并配置好镜像源。

## 使用包管理器

<!-- node:pkg-intro -->我们建议使用 \`pnpm\` 安装 {{组件名}}，企业用户可走内网镜像。

- Node.js 20+ 环境
- 包管理器可用
- 已配置 registry 镜像
`

// 英文 v2：前置条件这一节「暂缺译文」（只有标题，正文 prereq 无英文）→ 来源缺失
const installEnV2 = `# Installation Guide

## Quick Install

<!-- node:install-cmd -->Run the install command (\`npm ci\` recommended):

\`\`\`bash
npm ci my-lib
\`\`\`

## Prerequisites

## Using a Package Manager

<!-- node:pkg-intro -->We recommend installing {{组件名}} with \`pnpm\`; enterprise users may use an internal mirror.

- Node.js 20+ environment
- A working package manager
- A configured registry mirror
`

// ---------- 《快速开始》：中文有 1/2 版，英文暂缺 ----------
const quickZhV1 = `# 快速开始

<!-- node:qs-intro -->引入组件后调用 \`createApp()\` 挂载 {{组件名}}。

<!-- node:qs-step -->第一步注册插件。
`
const quickZhV2 = `# 快速开始

<!-- node:qs-step -->第一步注册插件。

<!-- node:qs-intro -->引入组件后调用 \`createApp()\` 挂载 {{组件名}}，随后启动开发服务器。
`

// ---------- 《常见问题》：1:N 对齐 + 两译者并发 ----------
const faqZh = `# 常见问题

<!-- node:faq-lock -->什么是整篇语言锁？它以某版原文为整体基线，原文一升级整篇即滞后。

<!-- node:faq-split -->段落图模式允许中文一段对应英文多段，按语义节点对齐，不按数组下标。
`
const faqEn = `# FAQ

<!-- node:faq-lock -->What is a whole-document language lock?

It pins an entire source version as the baseline; once the source advances, the whole lock is stale.

<!-- node:faq-split-a -->In graph mode, one Chinese paragraph may map to several English ones.

<!-- node:faq-split-b -->Alignment follows semantic nodes, never array indices.
`

/** 在给定（已打开/已重置）的数据库上灌入种子数据 */
export function seedInto(db) {
  const t = now()

  function doc(id, slug, sourceLang, title) {
    db.prepare(`INSERT INTO documents(doc_id, slug, source_lang, title, created_at) VALUES (?,?,?,?,?)`)
      .run(id, slug, sourceLang, title, t)
  }

  doc('install', 'install', 'zh', '安装指南')
  publishVersion(db, { docId: 'install', lang: 'zh', versionNo: 1, markdown: installZhV1, editor: 'a-liu', note: '初版' })
  publishVersion(db, { docId: 'install', lang: 'en', versionNo: 1, markdown: installEnV1, editor: 'b-wang', note: '初版英译' })
  bootstrapUnits(db, 'install', ['en'])
  autoAlign(db, 'install', 'zh', 'en', { srcVersion: 1, tgtVersion: 1 })

  // 英文 v1 译齐并验收（verified + 基线）。译文正文取「对齐到的英文节点」内容，
  // 经边 src_key -> tgt_key 解析，不假设两边 key/下标一致。
  const v1SrcKeys = db.prepare(`SELECT node_key FROM nodes
    WHERE doc_id='install' AND lang='zh' AND version_no=1 AND type!='code' ORDER BY ord`).all().map((r) => r.node_key)
  const tgtRaw = (key) => db.prepare(`SELECT t.tgt_node_key k, n.raw_content v FROM alignment_edges t
    JOIN nodes n ON n.doc_id=t.doc_id AND n.lang=t.tgt_lang AND n.version_no=1 AND n.node_key=t.tgt_node_key
    WHERE t.doc_id='install' AND t.src_lang='zh' AND t.tgt_lang='en' AND t.status='active' AND t.src_node_key=?
    ORDER BY t.edge_id LIMIT 1`).get(key)
  for (const srcKey of v1SrcKeys) {
    const mapped = tgtRaw(srcKey)
    if (!mapped || !mapped.v) continue
    saveUnit(db, { doc: 'install', srcNodeKey: srcKey, tgtLang: 'en', body: mapped.v, actor: 'translator-x', baseRevision: 0 })
    submitUnit(db, { doc: 'install', srcNodeKey: srcKey, tgtLang: 'en', actor: 'translator-x' })
    verifyUnit(db, { doc: 'install', srcNodeKey: srcKey, tgtLang: 'en', reviewer: 'reviewer-1' })
  }

  // 发布中文 v2（章节重排 + 改写 + 代码更新）与英文 v2（前置条件译文暂缺）
  publishVersion(db, { docId: 'install', lang: 'zh', versionNo: 2, markdown: installZhV2, editor: 'a-liu', note: '命令提前；Node20；pnpm' })
  publishVersion(db, { docId: 'install', lang: 'en', versionNo: 2, markdown: installEnV2, editor: 'b-wang', note: '前置条件待译' })
  autoAlign(db, 'install', 'zh', 'en', { srcVersion: 2, tgtVersion: 2 })
  // 新列表项无显式 id；自动按章节顺序。确保新增第三条被识别为来源缺失（英文 v2 缺 prereq 正文）

  // install-cmd：译者已跟进代码改动（npm install -> npm ci），重新提交进入 in_review。
  // pkg-intro：源文案从 npm 改成 pnpm 但译者尚未跟进——它在 v1 曾验收，v2 解析时应为
  // 「原文已改 · 待复核(stale)」，证明原文修改只影响相关译段、未改段仍保留 verified。
  {
    const node = db.prepare(`SELECT raw_content FROM nodes WHERE doc_id='install' AND lang='en' AND version_no=2 AND node_key='install-cmd'`).get()
    if (node) {
      const cur = db.prepare(`SELECT revision FROM translation_units WHERE doc_id='install' AND src_node_key='install-cmd' AND tgt_lang='en'`).get()
      saveUnit(db, { doc: 'install', srcNodeKey: 'install-cmd', tgtLang: 'en', body: node.raw_content, actor: 'translator-y', baseRevision: cur.revision })
      submitUnit(db, { doc: 'install', srcNodeKey: 'install-cmd', tgtLang: 'en', actor: 'translator-y' })
    }
  }

  // ---- 快速开始：英文暂缺 ----
  doc('quickstart', 'quickstart', 'zh', '快速开始')
  publishVersion(db, { docId: 'quickstart', lang: 'zh', versionNo: 1, markdown: quickZhV1, editor: 'a-liu' })
  publishVersion(db, { docId: 'quickstart', lang: 'zh', versionNo: 2, markdown: quickZhV2, editor: 'a-liu', note: '重排+扩写' })
  bootstrapUnits(db, 'quickstart', ['en']) // en 无版本 -> 语言暂缺

  // ---- FAQ：1:N 人工对齐 + 两译者并发冲突 ----
  doc('faq', 'faq', 'zh', '常见问题')
  publishVersion(db, { docId: 'faq', lang: 'zh', versionNo: 1, markdown: faqZh, editor: 'a-liu' })
  publishVersion(db, { docId: 'faq', lang: 'en', versionNo: 1, markdown: faqEn, editor: 'b-wang' })
  bootstrapUnits(db, 'faq', ['en'])
  autoAlign(db, 'faq', 'zh', 'en')
  // 中文一段 faq-split -> 英文两段（人工 1:N）
  setManualAlignment(db, 'faq', 'zh', 'en', ['faq-split'], ['faq-split-a', 'faq-split-b'], 'reviewer-1')
  // faq-lock 正常译并验收
  const lockEn = db.prepare(`SELECT raw_content FROM nodes WHERE doc_id='faq' AND lang='en' AND version_no=1 AND node_key='faq-lock'`).get()
  saveUnit(db, { doc: 'faq', srcNodeKey: 'faq-lock', tgtLang: 'en', body: lockEn.raw_content, actor: 'tx', baseRevision: 0 })
  verifyUnit(db, { doc: 'faq', srcNodeKey: 'faq-lock', tgtLang: 'en', reviewer: 'rv' })

  // 两译者编辑同段 faq-split：译者 A 先存成功，译者 B 基于旧 revision 存 -> 409 冲突
  saveUnit(db, { doc: 'faq', srcNodeKey: 'faq-split', tgtLang: 'en', body: 'In graph mode a Chinese paragraph may map to several English ones; nodes not indices.', actor: 'translator-A', baseRevision: 0 })
  let conflict = null
  try {
    saveUnit(db, { doc: 'faq', srcNodeKey: 'faq-split', tgtLang: 'en', body: 'One zh paragraph -> multiple en paragraphs, aligned by semantic node.', actor: 'translator-B', baseRevision: 0 })
  } catch (e) {
    if (e.status !== 409) throw e
    conflict = { conflictId: e.conflictId, serverRevision: e.serverRevision }
  }
  if (!conflict) throw new Error('expected optimistic-lock conflict was not raised')

  // install：给一条整篇语言锁（锁在源 v1），用于演示 lock 模式下源升级后整篇滞后
  db.prepare(`INSERT INTO language_locks(doc_id, tgt_lang, src_version, locked_at, locked_by)
    VALUES ('install','en',1,?, 'release-manager')`).run(t)

  // 将种子 markdown 也落盘到 data，便于查看
  const dump = path.join(dataDir, 'sources')
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(path.join(dump, 'install.zh.v1.md'), installZhV1)
  fs.writeFileSync(path.join(dump, 'install.en.v1.md'), installEnV1)
  fs.writeFileSync(path.join(dump, 'install.zh.v2.md'), installZhV2)
  fs.writeFileSync(path.join(dump, 'install.en.v2.md'), installEnV2)
  fs.writeFileSync(path.join(dump, 'quickstart.zh.v2.md'), quickZhV2)
  fs.writeFileSync(path.join(dump, 'faq.zh.md'), faqZh)
  fs.writeFileSync(path.join(dump, 'faq.en.md'), faqEn)

  return { conflict }
}

/** 重置指定文件数据库并灌入种子 */
export function seed(dbPath = path.join(dataDir, 'i18n.db')) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = resetDb(dbPath)
  const { conflict } = seedInto(db)
  return { db, dbPath, conflict }
}

function now() { return Date.now() }

// 可直接运行：node scripts/seed.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dbPath, conflict } = seed()
  console.log('seeded:', dbPath)
  console.log('two-translator conflict recorded:', conflict)
}
