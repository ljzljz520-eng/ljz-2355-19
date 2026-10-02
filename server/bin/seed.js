// 演示数据装载。顺序经过设计：
//  v1(zh+en) -> 翻译 verified(基线 v1) -> v2(zh 部分修改) -> v3(zh 重排) -> v3(en)
// 最后摄入 v3 译文时 rebuildEdges 会复用既有人工/已验边（nid 是稳定身份），
// 因而 intro 保持 verified，install-desc/usage-desc 因原文 hash 变化降级 stale。
import fs from 'node:fs'
import path from 'node:path'

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null)

export async function seed(db, root) {
  const { ingestVersion, saveTranslation, reviewTranslation } = await import('../src/content.js')

  const qs = path.join(root, 'content', 'quickstart')

  // 1) v1 双语 + 审阅通过（基线 = zh v1）
  ingestVersion(db, { docId: 'quickstart', lang: 'zh', raw: read(path.join(qs, 'history/v1/zh.md')), title: '快速开始' })
  ingestVersion(db, { docId: 'quickstart', lang: 'en', raw: read(path.join(qs, 'history/v1/en.md')), title: 'Quick Start' })
  for (const [srcNid, content] of [
    ['intro', 'This section explains how to use My Component Lib in your project.'],
    ['install-desc', 'We recommend installing via NPM.'],
    ['usage-desc', 'Call `createApp` in your entry file and register `MyComponentLib`.']
  ]) {
    const tgtNid = srcNid // v1 英文沿用相同 nid
    saveTranslation(db, { docId: 'quickstart', srcLang: 'zh', tgtLang: 'en', srcNid, tgtNid, content, actor: 'translator-a' })
    reviewTranslation(db, { docId: 'quickstart', srcLang: 'zh', tgtLang: 'en', srcNid, tgtNid, status: 'verified', reviewer: 'reviewer-1' })
  }

  // 2) v2 仅原文：install/usage 改动
  ingestVersion(db, { docId: 'quickstart', lang: 'zh', raw: read(path.join(qs, 'history/v2/zh.md')), title: '快速开始' })

  // 3) v3 原文重排
  ingestVersion(db, { docId: 'quickstart', lang: 'zh', raw: read(path.join(qs, 'zh.md')), title: '快速开始' })

  // 4) v3 译文（拆段一对多、共享代码；目标 nid 改为 en- 前缀）
  //    旧边的 src nid 仍有效：保留 intro（verified）；install/usage 已 stale。
  //    旧目标 nid 不再存在 -> 旧边结转 orphaned，由人工确认入口处理；这里演示人工确认到新目标。
  ingestVersion(db, { docId: 'quickstart', lang: 'en', raw: read(path.join(qs, 'en.md')), title: 'Quick Start' })

  // 4.5) intro 在 v3 有新增：译者更新译文并复审通过 -> verified（基线更新到 v3=zh v3）
  //      install-desc / usage-desc 未重新审阅 -> 保持 stale，页面上明确区分
  saveTranslation(db, {
    docId: 'quickstart', srcLang: 'zh', tgtLang: 'en', srcNid: 'intro', tgtNid: 'intro',
    content:
      'This section explains how to use My Component Lib in your project and get your first component running in three minutes.',
    actor: 'translator-a'
  })
  reviewTranslation(db, {
    docId: 'quickstart', srcLang: 'zh', tgtLang: 'en', srcNid: 'intro', tgtNid: 'intro',
    status: 'verified', reviewer: 'reviewer-1'
  })

  // 5) FAQ 仅中文（某语言暂缺）
  const faq = path.join(root, 'content', 'faq')
  ingestVersion(db, { docId: 'faq', lang: 'zh', raw: read(path.join(faq, 'zh.md')), title: '常见问题' })

  return { ok: true }
}
