// SQLite 持久层（sql.js / WASM，零原生编译依赖）。
// 写操作在事务中批量执行，commit 后落盘到 data/i18n.sqlite。
import initSqlJs from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
export const DEFAULT_DB_FILE = path.join(ROOT, 'server', 'data', 'i18n.sqlite')
const SCHEMA_FILE = path.join(ROOT, 'server', 'db', 'schema.sql')
const WASM_FILE = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')

let _db = null
let _file = DEFAULT_DB_FILE
let _spDepth = 0

export async function openDb(file = DEFAULT_DB_FILE) {
  const SQL = await initSqlJs({ locateFile: () => WASM_FILE })
  _file = file
  if (fs.existsSync(file)) {
    _db = new SQL.Database(fs.readFileSync(file))
  } else {
    _db = new SQL.Database()
    _db.run(fs.readFileSync(SCHEMA_FILE, 'utf-8'))
    persist()
  }
  _db.run('PRAGMA foreign_keys = ON')
  return makeApi()
}

function persist() {
  fs.mkdirSync(path.dirname(_file), { recursive: true })
  fs.writeFileSync(_file, Buffer.from(_db.export()))
}

function rows(stmt) {
  const out = []
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

function makeApi() {
  return {
    raw: () => _db,
    all(sql, params = {}) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) throw new Error(`绑定参数 ${k} 为 undefined；SQL: ${sql.slice(0, 160)}`)
      }
      const stmt = _db.prepare(sql)
      stmt.bind(params)
      return rows(stmt)
    },
    get(sql, params = {}) {
      return this.all(sql, params)[0] ?? null
    },
    run(sql, params = {}) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) throw new Error(`绑定参数 ${k} 为 undefined；SQL: ${sql.slice(0, 120)}`)
      }
      const stmt = _db.prepare(sql)
      stmt.bind(params)
      stmt.step()
      stmt.free()
    },
    /** 批量事务；fn 内只操作内存，统一 commit + 落盘（支持 SAVEPOINT 嵌套） */
    tx(fn) {
      const depth = _spDepth++
      const sp = `sp_${depth}`
      if (depth === 0) _db.run('BEGIN')
      else _db.run(`SAVEPOINT ${sp}`)
      try {
        const r = fn(this)
        if (depth === 0) {
          _db.run('COMMIT')
          persist()
        } else _db.run(`RELEASE SAVEPOINT ${sp}`)
        _spDepth--
        return r
      } catch (e) {
        if (depth === 0) _db.run('ROLLBACK')
        else _db.run(`ROLLBACK TO SAVEPOINT ${sp}`)
        _spDepth--
        throw e
      }
    },
    close() {
      persist()
      _db.close()
    },
    persist
  }
}
