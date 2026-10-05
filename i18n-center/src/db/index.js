import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let _db = null

export function openDb(dbPath = process.env.I18N_DB || path.join(__dirname, '../../data/i18n.db')) {
  if (_db) return _db
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  _db.exec(schema)
  return _db
}

export function resetDb(dbPath) {
  if (_db) { _db.close(); _db = null }
  if (dbPath && fs.existsSync(dbPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix
      if (fs.existsSync(p)) fs.rmSync(p)
    }
  }
  return openDb(dbPath)
}

/** 清空业务表但保持连接（供运行中的服务重新播种） */
export function clearTables(db) {
  const tables = [
    'review_actions', 'review_queue', 'edit_conflicts', 'unit_history',
    'unit_baselines', 'translation_units', 'alignment_edges', 'nodes', 'code_snippets',
    'language_locks', 'document_versions', 'documents'
  ]
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => { for (const t of tables) db.prepare(`DELETE FROM ${t}`).run() })
  tx()
  db.pragma('foreign_keys = ON')
}
