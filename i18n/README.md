# 文档中心 · 双语阅读

左（原文）右（译文）双栏按**语义节点**同步滚动，而不是按数组下标对齐；
内容 API 同时提供每个文档的**语言版本**与节点间的**对应关系图**；
SQL 保存每段译文的**翻译基线版本**与**审阅状态**，并提供整篇语言锁与段落级锁。

## 为什么不用“整篇语言锁”作为唯一手段

| | 整篇语言锁 | 段落级对齐图（本方案） |
| :-- | :-- | :-- |
| 粒度 | 一个语言同时只能一人编辑 | 不同段落可并行 |
| 章节重排 | 锁与文件绑定，重排后难以定位 | 节点 nid 稳定，顺序（ord）变化不影响对应 |
| 中文一段→英文多段 | 数组下标必然错位 | 多条边表达 1:n / n:1 |
| 某语言暂缺 | 无法表达 | `targetMissing` 结构化返回 |
| 原文改版 | 全量失效或全量伪装同步 | 未改段保留 verified，改动段降级 stale |

整篇语言锁仍被保留（`POST /api/locks`），用于发布窗口等需要排他的场景；
日常协作走段落级图 + 段落锁（`POST /api/locks/segment`）+ 乐观版本号。

## 标记语法（Markdown 注释，不改变渲染）

```markdown
<!-- i18n:id=intro -->
这是一个语义节点。

<!-- i18n:id=en-intro xref=intro -->
This is one semantic node.

<!-- 中文一段被拆成两个英文段：两条边，同一 src_nid -->
<!-- i18n:id=en-split-a xref=split -->
First half.
<!-- i18n:id=en-split-b xref=split -->
Second half.

<!-- n:1 合并：一个英文段对应两个中文段 -->
<!-- i18n:id=en-merged xref=sec-a xref=sec-b -->

<!-- 共享代码：正文不复制，按 codeRef 引用同一份 -->
<!-- i18n:id=install-code code=install-npm lang=bash -->
```bash
npm install x
```
```

- 行内代码 `` `createApp` ``、`` `options` `` 与 `[[keep:MyComponentLib]]` 是**受保护片段**，
  保存译文时若未原样引用，API 返回 `422 protected-token-missing`。
- 没有显式 `id` 的普通段落得到 `auto-*` nid 且 `nid_auto=1`，**不参与隐式对齐猜测**，
  只能通过审阅面板的“人工建立对应”入口处理。

## 审阅状态机

```
草稿 draft ──提交审阅──> in_review ──通过──> verified
   ▲                         │                │
   └──── 译文内容被再次保存 ──┴──── 回到 in_review（不冒充已验）

原文改版后按查看版本实时计算 effective 状态：
  verified       基线==当前原文版本 且 该节点内容 hash 未变
  stale          基线版本中该节点 hash 与当前不同（原文修改，相关译段待复核）
  untranslated   没有对应译文
  missing-source 译文 xref 的原文节点在该版本不存在（章节删除/重写）
```

关键不变量：**未改段保留 verified，改动相关段才待复核**——状态挂在稳定 nid 上比较
“基线版本 hash vs 查看版本 hash”，与段落在章节中的位置无关，所以章节重排不丢状态。

## API 摘要

| 方法 | 路径 | 说明 |
| :-- | :-- | :-- |
| GET | `/api/docs` | 文档与语言矩阵 |
| GET | `/api/reader/:docId?srcLang&tgtLang&srcVersion&tgtVersion` | 双栏装配：版本 + 图 + 基线状态 + 诊断 + 锁 |
| POST | `/api/ingest` | 摄入语言版本（hash 未变则幂等，不产生新版本） |
| POST | `/api/translations` | 保存译文（锁校验 423 / 乐观冲突 409 / 受保护片段 422） |
| POST | `/api/translations/review` | draft/in_review/verified 流转 |
| POST/DELETE | `/api/locks` | 整篇语言锁（TTL） |
| POST | `/api/locks/segment` | 段落锁（两译者同段） |
| POST | `/api/edges/:id/decision` | 人工确认 / 否决对齐边 |
| POST | `/api/edges/manual` | 来源缺失/重排后人工建立对应 |
| GET | `/api/search?q&lang&version&docId` | 搜索，可带 `version` 进入历史版 |
| GET | `/api/docs/:docId/versions` | 版本历史 |

`GET /api/reader/:docId` 的关键字段：

```jsonc
{
  "srcVersion": 1, "srcCurrentVersion": 3, "srcIsLatest": false, // 明确“基于哪版原文”
  "targetMissing": false,
  "columns": { "source": [/* 含 nid/ord/code 引用 */], "target": [/* … */] },
  "pairs": [{
    "srcNid": "install-desc", "tgtNid": "install-desc", "rel": "1:n",
    "origin": "xref|code|manual",
    "status": { "effective": "stale", "baselineVersion": 1, "missingTokens": [] }
  }],
  "diagnostics": {
    "missingSource": [/* 译文指向了不存在的原文节点 */],
    "ambiguous":     [/* 拆段与合并交叉，归属歧义 */],
    "orphaned":      [/* 译文节点在当前版本消失 */],
    "unmatchedSrc":  [], "unmatchedTgt": []
  },
  "counts": { "verified": 1, "stale": 2 },
  "locks": { "language": null, "segments": [] }
}
```

## 前端

- `docs/.vitepress/theme/components/i18n/useSyncedScroll.js`：以 pairs 建 `src2tgt/tgt2src`
  映射；主动列取视口中心节点，对侧滚到对应节点；一对多时选最近对应；无对应时按 ord 兜底
  并标记 `aligned=false`（不做跳变式假同步）；带事件锁防止双向回环。
- `BilingualReader.vue`：版本选择器、**基线/历史横幅**、状态徽标、审阅面板（冲突/待复核/
  未匹配三栏）、翻译弹窗（段落锁 + 乐观 hash + 受保护片段提示）、搜索并跳到历史版语义节点。
- 数据来源：优先 `/api/...`（Vite 中间件代理到 `:5174`，见 `docs/.vitepress/apiProxy.ts`）；
  API 不可用时回退到 `docs/public/i18n/**/reader.json` 构建期快照，并在顶部标注“构建期快照”。
  快照只承载真实状态（可能是 stale），**不会把过期译文包装成完全同步**。

## 本地运行

```bash
npm install
npm test                 # 39 个测试：解析/对齐图/状态机/锁冲突/HTTP/前端内核
npm run i18n:reset       # 建库 + 播种历史版 + 生成静态快照
npm run i18n:serve &      # 内容 API http://localhost:5174
npm run docs:dev          # 文档站（/api 已代理）
# 打开 http://localhost:5173/bilingual/quickstart
```

## 测试场景对照

| 需求场景 | 入口 |
| :-- | :-- |
| 章节重排 | `quickstart` v3（段落 ord 变化、nid 不变，verified 保留） |
| 某语言暂缺 | `/bilingual/faq`（仅中文，右栏显式为空） |
| 代码更新 | codeRef 改名/内容变化，双语列引用同一 codeRef（集成测试 codeupd） |
| 两译者编辑同段 | 段落锁 423 + 乐观 hash 409（集成测试 + 翻译弹窗提示） |
| 搜索进入历史版 | 页内搜索选 v1，或 `/bilingual/quickstart-history-v1`，横幅声明历史版 |
| 滚动保持语义位置 | `useSyncedScroll` + `restoreAnchor(nid)`，无对齐按 ord 兜底 |
| 来源缺失/对齐冲突 | 审阅面板“冲突与缺失”：确认 / 否决 / 人工建立对应 |
