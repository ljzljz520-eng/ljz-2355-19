# 双语文档中心（内容 API + 对照阅读器）

## 架构

```
server/
  db.js         SQLite 模式：版本、语义段、对齐图、翻译基线、审阅状态、语言锁
  segmenter.js  Markdown → 语义节点；seg_key 跨版本继承（内容哈希 + 相似度，非数组下标）
  repo.js       领域逻辑：发布、对齐、基线漂移、乐观锁、语言锁比对、跨版本搜索
  api.js        HTTP API（Node 内置 http，无框架依赖）
  public/       对照阅读器（左右栏语义同步滚动）
scripts/seed.mjs  从 docs/ 中英文 Markdown 建库
tests/            场景测试（node:test）+ 阅读器 e2e（jsdom）
```

## 数据模型要点

| 表 | 作用 |
| --- | --- |
| `documents` | 文档与整篇语言锁 `lock_json` |
| `doc_versions` / `segments` | 每语言多版本；段有稳定 `seg_key`（语义节点） |
| `code_blocks` | 共享代码单一来源，译段只存 `code_ref`，不复制 |
| `alignments` | 多对多语义对齐（中文一段 ↔ 英文多段），跨版本存续 |
| `segment_status` | 翻译基线哈希 + 审阅状态 + `lock_version` 乐观锁 |

## 关键行为

- **原文修改** → 仅基线漂移的译段 `needs_review`，未改段保留 `verified`
- **章节重排** → `seg_key` 内容寻址继承，对齐与状态不漂移
- **源段删除** → 对应译段 `missing_source`，进入孤儿列表待人工处理
- **两译者同段** → `lock_version` 乐观锁，后提交者收 409 与当前状态
- **语言锁** → 仅全部译段已验证可锁；锁与段落图不一致时报告 `stale`/`broken`，
  `presentableAsSynced=false` 时前端绝不显示「完全同步」

## API 摘要

```
GET  /api/docs                              文档列表（含各语言版本与锁）
GET  /api/docs/:id/bilingual?tgt=en         双语对齐视图（可带 srcVersion/tgtVersion 进历史版）
GET  /api/docs/:id/sync-report?tgt=en       整篇语言锁 vs 段落级对齐图
POST /api/docs/:id/versions                 发布新版本 {lang, markdown|blocks}
POST /api/docs/:id/translations             提交译段（乐观锁 expectedLockVersion）
POST /api/docs/:id/confirm                  人工确认译段
POST /api/docs/:id/alignments               人工调整对齐（支持一对多）
POST/DELETE /api/docs/:id/lock              整篇语言锁
PUT  /api/code-blocks/:id                   共享代码更新（双语同时生效）
GET  /api/search?q=                         跨版本搜索（含历史版，isLatest 标注）
```
