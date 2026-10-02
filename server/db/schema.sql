-- ============================================================================
-- 文档中心 · 双语阅读 数据模型
--
-- 设计要点（对应需求）：
--  1. 对齐基于“语义节点 ID（nid）”的显式边，而非数组下标；
--     中文段落拆分后英文一对多通过多条 edge 自然表达。
--  2. translation 保存 source_version（翻译基线）与 review 状态；
--     原文修改后：未改节点保留 verified，改动相关节点降级 stale，未对齐节点 missing。
--  3. code_ref：正文不复制代码，跨语言/跨版本共享同一份代码引用。
--  4. doc_locks：整篇语言锁；seg_locks：段落级锁（两人同段并发控制）。
--  5. alignment_edges 不使用指向 versions 表的级联外键（节点可在版本间消失），
--     missing-source 以 left join 计算，不删历史边。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 文档 ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,                 -- slug，如 quickstart
  title        TEXT NOT NULL,
  current_ver  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 文档语言矩阵（某语言暂缺 = 该语言无 current_ver 行） -----------------------
CREATE TABLE IF NOT EXISTS doc_langs (
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang          TEXT NOT NULL,                    -- zh | en
  current_ver   INTEGER NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (doc_id, lang)
);

-- 文档版本（每次 ingest 内容 hash 变化才产生新版本） --------------------------
CREATE TABLE IF NOT EXISTS doc_versions (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  lang       TEXT NOT NULL,
  content    TEXT NOT NULL,                       -- 原始 markdown（历史版可回看）
  hash       TEXT NOT NULL,                       -- 规范化内容 hash
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (doc_id, lang, version)
);

-- 语义节点（跨版本的稳定身份是 nid；行随版本内容快照） -----------------------
CREATE TABLE IF NOT EXISTS segments (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  lang       TEXT NOT NULL,
  nid        TEXT NOT NULL,                       -- 稳定语义节点 ID（显式标记/标题 slug）
  ord        INTEGER NOT NULL,                    -- 该版本内顺序（章节重排后 ord 变、nid 不变）
  kind       TEXT NOT NULL,                       -- heading|paragraph|list|table|code|html
  level      INTEGER,                             -- heading 层级
  content    TEXT NOT NULL,                       -- 规范化正文
  hash       TEXT NOT NULL,                       -- 内容 hash
  code_ref   TEXT,                                -- kind=code 且共享代码时的引用名
  nid_auto   INTEGER NOT NULL DEFAULT 0,          -- 1=nid 为隐式生成（章节重排不可靠，仅建议对齐）
  FOREIGN KEY (doc_id, lang, version)
    REFERENCES doc_versions(doc_id, lang, version) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, version, lang, nid)
);

-- 代码仓库（共享代码、参数名保持引用一致；正文不复制一份失去版本联系的代码） --
CREATE TABLE IF NOT EXISTS code_refs (
  name       TEXT PRIMARY KEY,                    -- 如 install-npm
  lang_hint  TEXT,                                -- 代码语言 bash|js|vue ...
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 段落级对齐图：边从译文节点指向原文节点 ------------------------------------
-- 一个 zh 段落被拆成两个 en 段落 => 两条边指向同一 src_nid（一对多，合法）。
-- 一个 en 段同时 xref 两个 zh 段（合并）=> 同样以两条边表达。
CREATE TABLE IF NOT EXISTS alignment_edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  src_lang      TEXT NOT NULL,                    -- 原文语言（基线方向，通常 zh）
  src_nid       TEXT NOT NULL,                    -- 原文 nid（不级联：源缺失时保留待人工处理）
  tgt_lang      TEXT NOT NULL,                    -- 译文语言（通常 en）
  tgt_nid       TEXT NOT NULL,
  rel           TEXT NOT NULL DEFAULT '1:1',      -- 1:1 | 1:n | n:1
  status        TEXT NOT NULL DEFAULT 'proposed', -- proposed | confirmed | rejected
  conflict      TEXT,                             -- NULL | ambiguous | missing-source | orphaned
  origin        TEXT NOT NULL DEFAULT 'xref',     -- xref | code | manual（边的来源）
  created_by    TEXT,
  reviewed_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (doc_id, src_lang, src_nid, tgt_lang, tgt_nid)
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON alignment_edges(doc_id, src_lang, src_nid);
CREATE INDEX IF NOT EXISTS idx_edges_tgt ON alignment_edges(doc_id, tgt_lang, tgt_nid);

-- 翻译基线与审阅状态 ---------------------------------------------------------
-- source_version 固定为“译文所基于的原文版本”；原文改版不改它。
-- status 为显式审阅状态；effective 状态在 ingest 时按基线/内容 hash 重算：
--   verified（基线=最新且 hash 未变）| stale（基线过期）| untranslated
CREATE TABLE IF NOT EXISTS translations (
  doc_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  src_lang         TEXT NOT NULL,
  src_nid          TEXT NOT NULL,
  tgt_lang         TEXT NOT NULL,
  tgt_nid          TEXT NOT NULL,
  source_version   INTEGER NOT NULL,              -- 翻译基线版本
  content          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,                 -- 译文内容 hash（译文修改触发冲突/重审）
  status           TEXT NOT NULL DEFAULT 'draft', -- draft | in_review | verified
  reviewer         TEXT,
  lock_owner       TEXT,                          -- 段落编辑锁（TTL）
  lock_until       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (doc_id, src_lang, src_nid, tgt_lang, tgt_nid)
);

CREATE INDEX IF NOT EXISTS idx_trans_tgt ON translations(doc_id, tgt_lang, tgt_nid);

-- 整篇语言锁（需求：比较整篇语言锁 vs 段落级对齐图） -------------------------
CREATE TABLE IF NOT EXISTS doc_locks (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL,                       -- 被锁定的语言
  owner      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'language',    -- language | section
  section    TEXT,                                -- scope=section 时锚定的 nid
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, lang, scope, section)
);

-- 操作审计（人工确认、状态流转、并发覆盖拒绝） -------------------------------
CREATE TABLE IF NOT EXISTS review_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL,
  action     TEXT NOT NULL,                       -- confirm-edge|reject-edge|review|save|lock|conflict
  payload    TEXT NOT NULL,                       -- JSON
  actor      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
