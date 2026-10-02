# 文档中心双语阅读系统（段落级语义对齐）

## 为什么不用数组下标对齐？

中文段落拆分后，英文常常是一对多（如 `p-install-1` → `p-install-1` + `p-install-2`）。
按下标对齐会在任何一侧增删段时整体错位且无声无息。本系统用一张**显式对齐图**：

```
source segment ──edge──▶ translation unit
                  ├─ edge_kind: one-to-one | one-to-many | many-to-one
                  ├─ edge_group（1:N 共享一个组，滚动/审阅视为同一语义节点）
                  └─ baseline_doc_version（该边对齐的是哪一版原文）
```

边按**原文版本分别存放**（`edgesByVersion` / SQL `alignment_edges.source_version`），
章节重排只是新版本的一组新边，旧边保留给历史视图。

## 目录

```
i18n/
├── core/               # 零依赖纯逻辑（前端 / Node 测试 / HTTP 服务三方共享）
│   ├── hash.js         # 规范化 + FNV-1a 基线哈希（含代码引用版本指纹、结构哈希）
│   ├── graph.js        # 对齐图、语义节点、1:N、整篇锁 vs 段落图比较
│   ├── status.js       # 边/段状态、冲突检测（来源缺失/目标缺失/重复映射/竞争提案）
│   ├── reviews.js      # 审阅提交（If-Match 乐观锁 409）、提案裁定
│   ├── anchor.js       # 跨版本语义锚点（稳定id → 标题+序号 → 内容相似度）
│   ├── content.js      # 内容 API 核心（HTTP 与静态阅读器共用的响应契约）
│   └── search.js       # 版本感知搜索（命中带 docVersion，打开即历史版）
├── fixtures/           # 精心构造的示例数据（见下）
├── store/              # 与 SQL 表同构的内存事务存储（开发/测试免数据库）
├── server/index.js     # 零依赖 HTTP 适配：npm run i18n:serve（端口 5174）
├── sql/schema.sql      # SQLite 建表：基线、审阅、版本号乐观锁、审计触发器
└── __tests__/          # node:test，27 个用例：npm run i18n:test
```

## 数据模型要点

- **结构化 token，不复制代码**：正文段是 `[{kind:'text'},{kind:'code-ref'|'param'|'literal', ref}]`。
  共享代码、参数名（`param:type`）、不可翻译标记（`lit:createApp` 🔒）都只存在于
  `registry` 一处，两种语言引用同一 id。代码升级 = registry 版本号 +1，所有引用段
  集中标记 `code-ref-changed`，译文正文不存在会失联的代码副本。
- **翻译基线**：`translation_reviews` 同时保存 `source_hash`、`source_doc_version`、
  `translation_hash`、`code_version`。原文修改只改变相关段哈希 → 只有相关边变
  `needs-review`；未改段保留 `verified`。
- **两译者并发**：审阅行有 `revision`；提交带 `If-Match`，SQL 触发器在
  `UPDATE ... WHERE revision = N` 失败时让 API 返回 `409 revision-conflict`，
  旧改永不静默覆盖新改，历史行进 `translation_review_history`。

## 状态语义（绝不把过期译文包装成完全同步）

| 状态 | 含义 |
| :-- | :-- |
| `confirmed` | 审阅存在、译文与存储一致、基线等于当前原文 |
| `needs-review` | 原文已改（基线哈希不一致），需要复核 |
| `code-ref-changed` | 段引用的共享代码升级了（正文没复制代码） |
| `source-missing` | 边指向当前版本已删除的原文段 |
| `target-missing` | 边指向不存在的译文单元（对齐缺陷） |
| `untranslated` | 原文段没有任何边 |
| `translated` | 有边有译文，但还没人工验证 |
| `stale-review` | 译文在审阅后又被改动 |

**整篇语言锁 vs 段落级对齐图**：`graph.describeLockVsGraph` 比较锁基线、各边基线集合与
当前原文版本。锁模式不允许部分同步——锁基线落后就整篇标过期；段落图模式允许
"未改段已验 + 已改段待复核"的混合状态。两种结论都在阅读器里明示。

**某语言暂缺**：`document_languages` 有行但无翻译单元时，API 返回 200 +
`targetAvailable:false` + `missing.reason`，右栏显示明确占位，绝不回退原文或谎称同步。

## HTTP API

`npm run i18n:serve` 后（前缀 `/api/i18n`）：

| 方法 | 路径 | 说明 |
| :-- | :-- | :-- |
| GET | `/docs` | 文档索引 |
| GET | `/docs/:id` | 元信息、版本、语言可用性 |
| GET | `/docs/:id/content?lang=&sourceVersion=` | 双栏数据：原文/译文单元/对齐图/状态/冲突 |
| GET | `/docs/:id/history/:version?lang=` | 冻结归档（带 latestVersion 与归档声明） |
| POST | `/reviews` (`If-Match`) | 提交验证；陈旧修订号 → 409 |
| POST | `/proposals/:id/decision` | 人工确认/驳回对齐提案 |
| GET | `/search?q=&lang=` | 命中带 `route.sourceVersion`（历史版） |

## 前端阅读器

`docs/.vitepress/theme/components/BilingualReader.vue`（演示页 `/bilingual-demo`）：

- 左右栏按语义节点同步滚动（节点顶部对齐线 + 节点内比例，非像素比例镜像）；
- 每段独立状态徽标，1:N 有 `1:2` 标记，孤儿边单独列出；
- 顶部横幅永远声明"译文基于哪版原文 / 最新原文是哪版 / 是否历史归档"；
- 冲突面板是人工确认入口：定位、批准/驳回提案；
- 审阅编辑器可模拟"另一译者同时编辑同段"复现 409；
- 搜索命中历史版本措辞时直接打开对应版本并标注归档；
- 切换版本时用语义锚点（稳定 id → 标题序号 → 相似度）尽量保持语义位置。

## 示例数据覆盖的场景

`components/button` 三个版本（1.0.0/1.1.0/1.2.0）：
章节重排、中文段→英文 1:N、共享代码 v1→v2、删段（source-missing）、
新段（untranslated）、错误边（target-missing、duplicate-target）、
竞争/悬空提案、1.2.0 只改一段（证明其他段保留 verified）；
`guide/installation`：整篇锁基线 1.0.0 落后原文 1.1.0；
`components/tag`：英文暂缺。
