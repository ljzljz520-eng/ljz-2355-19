// 前端静态快照：VitePress 静态构建/无后端时，阅读器直接读取这些 JSON。
// - reader.json                 当前版本对（含基线/冲突，不伪造同步）
// - v<srcVersion>.reader.json   每个原文版本的视图（历史版进入、搜索定位用）
// 只承载 getReader 的真实装配结果；状态可能为 stale，页面据此显式提示。
import fs from 'node:fs'
import path from 'node:path'
import { getReader, listDocs, versions } from '../src/content.js'

export async function buildSnapshot(db, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const docs = listDocs(db)
  for (const d of docs) {
    const langs = new Set(d.langs.map((l) => l.lang))
    const hasEn = langs.has('en')
    fs.mkdirSync(path.join(outDir, d.id), { recursive: true })

    const write = (name, payload) =>
      fs.writeFileSync(path.join(outDir, d.id, name), JSON.stringify(payload))

    const current = getReader(db, { docId: d.id, srcLang: 'zh', tgtLang: 'en' })
    write('reader.json', current)

    // 每个原文版本一视图（当前版本之外也提供）
    const vs = versions(db, d.id).filter((v) => v.lang === 'zh')
    for (const v of vs) {
      write(`v${v.version}.reader.json`, getReader(db, { docId: d.id, srcLang: 'zh', tgtLang: 'en', srcVersion: v.version }))
    }

    write(
      'versions.json',
      { docId: d.id, versions: versions(db, d.id), targetMissing: !hasEn, snapshotVersions: vs.map((v) => v.version) }
    )
  }
  fs.writeFileSync(path.join(outDir, 'docs.json'), JSON.stringify({ docs }, null, 2))
}
