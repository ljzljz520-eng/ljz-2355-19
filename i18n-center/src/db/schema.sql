-- 文档中心双语阅读：SQL 保存翻译基线与审阅状态
-- 设计原则：
--   1. 节点身份(node_key)跨版本稳定，章节重排不破坏对齐；
--   2. 对齐是多对多边(alignment_edges)，中文一段可对英文多段，不按数组下标；
--   3. 翻译基线 = 翻译验收时源端节点内容的 hash 清单(baseline_*)，源改动后
--      仅相关译段变 stale，未改段保留 verified；
--   4. 共享代码以 sha 去重(code_snippets)，两语言引用同一行，译文不复制代码；
--   5. 翻译单元带 revision 乐观锁，两译者并发编辑可检测冲突并人工合并。

CREATE TABLE IF NOT EXISTS documents (
  doc_id      TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  source_lang TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 版本是不可变的发布快照；搜索进入历史版即钉住某一对版本
CREATE TABLE IF NOT EXISTS document_versions (
  doc_id       TEXT NOT NULL REFERENCES documents(doc_id),
  lang         TEXT NOT NULL,
  version_no   INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  editor       TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id, lang, version_no)
);

-- 共享代码：同一份代码只有一行；正文节点用 sha 引用，不复制一份失去版本联系
CREATE TABLE IF NOT EXISTS code_snippets (
  sha       TEXT PRIMARY KEY,  -- sha1(normalize(code))
  language  TEXT NOT NULL,
  code      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 语义节点（段落/标题/列表项/代码块）。(doc_id, lang, version_no, node_key)
CREATE TABLE IF NOT EXISTS nodes (
  doc_id     TEXT NOT NULL REFERENCES documents(doc_id),
  lang       TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  node_key   TEXT NOT NULL,
  ord        INTEGER NOT NULL,       -- 本版本内顺序
  type       TEXT NOT NULL,          -- heading | paragraph | list_item | code
  heading_level INTEGER,
  heading_path  TEXT NOT NULL DEFAULT '', -- 语言相关标题文本路径（展示用）
  section_path  TEXT NOT NULL DEFAULT '', -- 语言无关结构路径 h0/h1（跨语言对齐用）
  content    TEXT NOT NULL,          -- 代码块存 sha；其余为原文（inline 已占位化）
  raw_content TEXT NOT NULL,         -- 未占位化原文，用于展示
  explicit_id INTEGER NOT NULL DEFAULT 0,
  content_sha TEXT NOT NULL,
  tokens_json TEXT NOT NULL DEFAULT '[]', -- 占位符 token: inline code / {{不可翻译}}
  PRIMARY KEY (doc_id, lang, version_no, node_key)
);
CREATE INDEX IF NOT EXISTS idx_nodes_ver ON nodes(doc_id, lang, version_no);
CREATE INDEX IF NOT EXISTS idx_nodes_sha ON nodes(content_sha);

-- 对齐图（有向边 source node -> target node，多对多）
CREATE TABLE IF NOT EXISTS alignment_edges (
  edge_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id       TEXT NOT NULL REFERENCES documents(doc_id),
  src_lang     TEXT NOT NULL,
  src_node_key TEXT NOT NULL,
  tgt_lang     TEXT NOT NULL,
  tgt_node_key TEXT NOT NULL,
  src_version  INTEGER NOT NULL DEFAULT 0,   -- 该对齐建立时的源版本
  tgt_version  INTEGER NOT NULL DEFAULT 0,   -- 目标版本（图存在版本对上）
  origin       TEXT NOT NULL DEFAULT 'auto', -- auto | manual
  status       TEXT NOT NULL DEFAULT 'active', -- active | dismissed
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- auto 边按版本对各自独立（历史版保留历史图）；manual 边跨版本沿用一条（版本戳记 0/0）
  UNIQUE (doc_id, src_lang, src_node_key, tgt_lang, tgt_node_key, origin, src_version, tgt_version)
);
CREATE INDEX IF NOT EXISTS idx_align_src ON alignment_edges(doc_id, src_lang, src_node_key, status);
CREATE INDEX IF NOT EXISTS idx_align_tgt ON alignment_edges(doc_id, tgt_lang, tgt_node_key, status);

-- 翻译单元：一个源节点 + 一个目标语言，承载译文正文与审阅状态
CREATE TABLE IF NOT EXISTS translation_units (
  doc_id        TEXT NOT NULL REFERENCES documents(doc_id),
  src_lang      TEXT NOT NULL,
  src_node_key  TEXT NOT NULL,
  tgt_lang      TEXT NOT NULL,
  tgt_node_key  TEXT,                 -- 已解析到的目标节点；缺失为 NULL
  body          TEXT NOT NULL DEFAULT '',
  body_raw      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'untranslated',
    -- untranslated | draft | in_review | verified | stale | conflict
  reviewer      TEXT,
  assignee      TEXT,
  revision      INTEGER NOT NULL DEFAULT 0,
  updated_by    TEXT,
  updated_at    INTEGER NOT NULL,
  -- 基线：验收/提交时，该单元对应源端分组的内容 hash 清单（规范化 JSON）
  baseline_group_sha TEXT,
  baseline_version   INTEGER,         -- 基线对应的源版本号
  verified_group_sha TEXT,            -- 最近一次人工验证通过时的源分组 hash
  PRIMARY KEY (doc_id, src_lang, src_node_key, tgt_lang)
);

-- 翻译单元操作审计（保存/提交/验证/标陈旧/重置）
CREATE TABLE IF NOT EXISTS unit_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id    TEXT NOT NULL,
  src_node_key TEXT NOT NULL,
  tgt_lang  TEXT NOT NULL,
  action    TEXT NOT NULL,
  actor     TEXT NOT NULL,
  at        INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

-- 两译者编辑同一单元的乐观锁冲突留痕
CREATE TABLE IF NOT EXISTS edit_conflicts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id       TEXT NOT NULL,
  src_node_key TEXT NOT NULL,
  tgt_lang     TEXT NOT NULL,
  actor        TEXT NOT NULL,
  at           INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  server_revision INTEGER NOT NULL,
  attempted_body TEXT NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0
);

-- 人工确认入口：来源缺失 / 对齐冲突 的处置队列
CREATE TABLE IF NOT EXISTS review_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- source_missing | alignment_conflict | token_mismatch | edit_conflict
  ref_key    TEXT NOT NULL,           -- 节点 key 或冲突 id
  lang       TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'open', -- open | resolved | ignored
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolver   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rq_open ON review_queue(doc_id, status);

-- 审阅操作审计（人工确认/解绑/重映射/忽略）
CREATE TABLE IF NOT EXISTS review_actions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  at        INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

-- 整篇语言锁：锁定义于「源版本」之上。源版本推进后，整篇即滞后，与段落图模式区分
CREATE TABLE IF NOT EXISTS language_locks (
  doc_id        TEXT NOT NULL REFERENCES documents(doc_id),
  tgt_lang      TEXT NOT NULL,
  src_version   INTEGER NOT NULL,
  locked_at     INTEGER NOT NULL,
  locked_by     TEXT NOT NULL,
  PRIMARY KEY (doc_id, tgt_lang)
);

-- 翻译基线按源版本留痕：查看历史版时用「当时版本」的基线判断，而不是最新基线
CREATE TABLE IF NOT EXISTS unit_baselines (
  doc_id        TEXT NOT NULL REFERENCES documents(doc_id),
  src_node_key  TEXT NOT NULL,
  tgt_lang      TEXT NOT NULL,
  src_version   INTEGER NOT NULL,
  group_sha     TEXT NOT NULL,
  was_verified  INTEGER NOT NULL DEFAULT 0,  -- 该版本下是否曾验收通过
  recorded_at   INTEGER NOT NULL,
  PRIMARY KEY (doc_id, src_node_key, tgt_lang, src_version)
);
