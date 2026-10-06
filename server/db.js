// SQLite 存储层：文档版本、语义段、对齐图、翻译基线与审阅状态
import Database from 'better-sqlite3'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,          -- 如 'guide/quickstart'
  title      TEXT NOT NULL,
  src_lang   TEXT NOT NULL DEFAULT 'zh',
  lock_json  TEXT                       -- 整篇语言锁 {srcVersion,tgtLang,tgtVersion,lockedBy,lockedAt}
);

CREATE TABLE IF NOT EXISTS doc_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL,
  lang       TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  author     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(doc_id, lang, version_no)
);

-- 语义段：属于某个语言版本；seg_key 是跨版本稳定的语义节点 ID（非数组下标）
CREATE TABLE IF NOT EXISTS segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   INTEGER NOT NULL REFERENCES doc_versions(id),
  seg_key      TEXT NOT NULL,
  seg_type     TEXT NOT NULL,           -- heading | paragraph | code
  content      TEXT NOT NULL DEFAULT '',-- code 段为空，正文在 code_blocks（不复制，保持版本联系）
  code_ref     TEXT,                    -- 共享代码块引用
  seq          INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(version_id, seg_key)
);

-- 共享代码块：两种语言引用同一行，更新一处即同步，不丢失版本联系
CREATE TABLE IF NOT EXISTS code_blocks (
  id         TEXT PRIMARY KEY,          -- 如 'guide/quickstart#code:1'
  content    TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- 段落级对齐图：多对多（中文一段可对应英文多段），跨版本存续
CREATE TABLE IF NOT EXISTS alignments (
  doc_id     TEXT NOT NULL,
  src_key    TEXT NOT NULL,
  tgt_lang   TEXT NOT NULL,
  tgt_key    TEXT NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0, -- 人工确认标记
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, src_key, tgt_lang, tgt_key)
);

-- 翻译基线与审阅状态（按语义节点，不随版本号漂移）
CREATE TABLE IF NOT EXISTS segment_status (
  doc_id        TEXT NOT NULL,
  tgt_lang      TEXT NOT NULL,
  tgt_key       TEXT NOT NULL,
  base_src_keys TEXT NOT NULL DEFAULT '[]', -- 翻译基于的源语义节点
  base_src_hash TEXT NOT NULL DEFAULT '{}', -- 翻译时各源段内容哈希（基线） {srcKey: hash}
  status        TEXT NOT NULL,              -- verified | needs_review | draft | missing_source | conflict
  translator    TEXT,
  lock_version  INTEGER NOT NULL DEFAULT 1, -- 乐观锁：两译者编辑同段时检测冲突
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (doc_id, tgt_lang, tgt_key)
);
`

export function openDb(file = ':memory:') {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export const now = () => new Date().toISOString()
