# 文档中心 · 双语阅读系统（段落级语义对齐）

左右双栏按**语义节点**同步阅读；内容 API 提供各语言版本与对应关系；SQL 保存翻译基线与
审阅状态。核心原则：**对齐是一张多对多的图，不是数组下标；共享代码/参数名按引用一致；
过期译文绝不被包装成「完全同步」。**

## 运行

```bash
npm run i18n:seed     # 灌入演示数据（含全部测试场景）到 i18n-center/data/i18n.db
npm run i18n:start    # 启动内容 API + 双语阅读前端 http://localhost:5180
npm run i18n:test     # node:test 自动化测试（20 例）
```

空库启动会自动播种。可用环境变量 `PORT`、`I18N_DB` 覆盖端口/数据库路径。
前端为零框架原生 ESM（`src/web/`），直接由 Node 内置 http 静态托管。

## 需求 → 实现对照

| 需求 | 实现 |
| --- | --- |
| 前端左右栏按**语义节点**同步 | 解析为 heading/paragraph/list_item/code 节点；滚动以「视口中心节点所属对齐组」映射到对栏同组节点居中（`web/scroll-map.js` 纯函数），非像素/下标硬绑 |
| 中文一段→英文多段，**不能按数组下标** | `alignment_edges` 多对多边 + union-find 连通分量（`align.js#buildGroups`），统一表达 1:N / N:1 / N:M；节点用稳定 `node_key` 身份 |
| 内容 API 提供语言版及对应关系 | `GET /api/reader?doc&tgt&mode&srcV&tgtV` 返回两版节点、对齐组、状态、共享代码；版本不可变 |
| 共享代码/参数名/不可翻译标记一致 | 代码块以 `code_snippets.sha` 去重，两栏引用同一行，译文不复制；inline code 与 `{{}}` 抽成占位符 token，保存时校验多重集一致（缺 token → `token_mismatch` 冲突） |
| SQL 保存翻译基线和审阅状态 | `translation_units`（状态机+revision 乐观锁）、`unit_baselines`（**按源版本**留痕基线）、`review_queue`/`review_actions`、`unit_history` |
| 原文修改→相关译段待复核；未改段保留已验 | 提交/验收时计算源分组内容 hash 清单；现版无新基线但旧已验基线 hash 不符 → `stale`；hash 一致 → 保留 `verified` |
| 整篇语言锁 vs 段落级对齐图 | `mode=lock`（`language_locks` 钉源版本，源升级整篇 `lock_behind_source`）与 `mode=graph`（逐段独立基线）可切换；`fully_synced` 严格判定 |
| 来源缺失 / 对齐冲突 / 人工确认入口 | 无边或目标节点缺失 → `missing`/`source_missing`；人工组重叠 → `alignment_conflict` 入审阅台；前端审阅台抽屉可确认/忽略/打开合并 |
| 章节重排 | 自动节点 key 基于**语言无关结构路径**（标题层级序号 `h0/h1`），跨语言同位置同 key；显式 `<!-- node:id -->` 更稳；两列各自按本版顺序渲染 |
| 某语言暂缺 | 目标语言无版本 → `target_available=false` + 醒目横幅，不崩；补齐发布后 `registerTargetLanguage` 补建单元 |
| 代码更新 | 代码内容变 → 新 sha，两栏仍按 sha 引用；关联译文状态按基线转 `code_outdated`/待复核 |
| 两译者编辑同段 | `saveUnit` 乐观锁：baseRevision≠服务端 revision → 409 + 落 `edit_conflicts` + 审阅台；人工合并后才落地 |
| 搜索进入历史版 | 命中带 (doc, lang, version, node_key)；URL 钉 `srcV/tgtV#node`，横幅明示「译文基于原文 vN」，不冒充当前同步 |
| 滚动保持语义位置 | 定位靠 node_key + 对齐组（`scrollToNode`），换版/重排后落同一语义处而非像素 |
| 页面明确基于哪版原文 | 顶部横幅始终显示源/译版本号、是否历史钉版、锁基线版本 |

## 关键数据模型（SQLite，见 `src/db/schema.sql`）

- `documents` / `document_versions`：文档与不可变版本快照
- `nodes(doc, lang, version, node_key)`：语义节点，`section_path` 语言无关、`heading_path` 语言相关
- `code_snippets(sha)`：共享代码唯一副本
- `alignment_edges(...src_version,tgt_version,origin)`：auto 边按版本对独立（历史版保留历史图），manual 边版本戳 0/0 跨版本沿用
- `translation_units`：译文正文 + 状态(untranslated/draft/in_review/verified/stale/conflict) + revision
- `unit_baselines(unit, src_version, group_sha, was_verified)`：**按源版本**的基线留痕
- `language_locks`：整篇锁；`edit_conflicts`：并发冲突；`review_queue`/`review_actions`：人工确认入口与审计

## 状态判定（`src/align/resolve.js`）

每组：来源缺失 → 目标缺失 → 人工/自动重叠 → 共享代码一致性 → 编辑冲突 →
token 引用一致性 → 基线比对（历史版只看当时基线；现版看旧已验基线是否仍匹配）。
`fully_synced` 仅当所有文本组 verified（锁模式还要求锁版本=最新源版本）才为真。

## API 一览

- `GET /api/documents` · `GET /api/reader` · `GET /api/search?q` · `GET /api/unit` · `GET /api/review`
- `POST /api/unit/save|submit|verify`（save 带 `baseRevision`）
- `POST /api/conflict/resolve`（人工合并）
- `POST /api/align/auto|manual|dismiss`
- `POST /api/lock/set|clear` · `POST /api/review/act` · `POST /api/code/refresh`
- `POST /admin/publish`（摄入新版本 markdown）· `POST /admin/reseed`

## 目录

```
src/db        schema.sql + 连接（better-sqlite3）
src/parser    Markdown 语义块解析、占位符抽取
src/content   版本摄入、翻译单元服务（基线/乐观锁/锁/审阅台）、搜索
src/align     自动/人工对齐、对齐图连通分量、阅读解析器
src/api       内置 http 服务（JSON API + 静态前端）
src/web       双语对照前端（零框架）
scripts/seed  覆盖全部场景的演示数据
test/         node:test 自动化测试
```
