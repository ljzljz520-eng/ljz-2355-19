#!/usr/bin/env node
// i18n CLI:
//   ingest  <docId> <lang> <file.md> [--title T]   摄入一个语言版本
//   serve   [--port 5174] [--db path]              启动内容 API
//   seed    [--root i18n]                          载入演示数据（含历史版）
//   snapshot <outDir>                             生成前端静态快照
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}

if (cmd === 'ingest') {
  const [, docId, lang, file] = argv
  const { openDb } = await import('../src/db.js')
  const { ingestVersion, rebuildEdges } = await import('../src/content.js')
  const db = await openDb(opt('db') || undefined)
  const raw = fs.readFileSync(path.resolve(file), 'utf-8')
  const r = ingestVersion(db, { docId, lang, raw, title: opt('title', docId) })
  console.log(JSON.stringify(r))
  db.close()
} else if (cmd === 'serve') {
  const { createServer } = await import('../src/api/server.js')
  const { port } = await createServer({ port: Number(opt('port', 5174)), dbFile: opt('db', undefined) })
  console.log(`i18n content API: http://localhost:${port}`)
} else if (cmd === 'seed') {
  const { seed } = await import('./seed.js')
  const { openDb } = await import('../src/db.js')
  const db = await openDb(opt('db') || undefined)
  await seed(db, path.resolve(ROOT, opt('root', 'i18n')))
  db.close()
  console.log('seed complete')
} else if (cmd === 'snapshot') {
  const { buildSnapshot } = await import('./snapshot.js')
  const { openDb } = await import('../src/db.js')
  const db = await openDb(opt('db') || undefined)
  await buildSnapshot(db, path.resolve(ROOT, argv[argv.length - 1]))
  db.close()
  console.log('snapshot written')
} else {
  console.log('usage: i18n <ingest|serve|seed|snapshot> ...')
  process.exit(1)
}
