# 项目自测报告（含双语阅读系统）

运行方式：

```bash
npm run i18n:test     # 27 个 node:test 纯逻辑/HTTP 用例
npm run i18n:serve    # 内容 API（http://localhost:5174/api/i18n）
npm run docs:dev      # VitePress，访问 /bilingual-demo 查看实时双栏阅读器
npm run docs:build    # 构建验证通过（vitepress v1.6.4, ~3.3s）
```

## 1. 需求逐项核对

| # | 需求 | 实现与验证 |
| :-- | :-- | :-- |
| 1 | 前端左右栏按语义节点同步 | `graph.semanticNode` + `useSyncScroll`：节点对齐线、节点内比例；1:N 组互跳；`scroll.test.js` 3 例 |
| 2 | 内容 API 提供语言版本及对应关系 | `content.js` 返回 sourceVersion/units/graph/states/conflicts；`server/index.js` 7 个路由；`api.test.js` 3 例 |
| 3 | SQL 保存翻译基线和审阅状态 | `i18n/sql/schema.sql`：reviews（source_hash/translation_hash/revision）+ history 触发器 + 新鲜度视图 |
| 4 | 中文拆分后英文 1:N，禁止下标对齐 | 显式边 + `edge_group`；fixture `p-install-1 → p-install-1,p-install-2`；`alignment.test.js` 第 1 例 |
| 5 | 共享代码/参数名/不可翻译标记引用一致 | `registry` 单一份，token 只持 ref；`status.test.js`「shared refs」「code update」断言无 body 副本 |
| 6 | 正文不复制失去版本联系的代码 | 译文 `code-ref` 单元只含 ref；代码升级走 registry v1→v2 → `code-ref-changed` |
| 7 | 原文修改使相关译段待复核，未改段保留已验 | 基线哈希逐段比对；1.2.0 仅改一段，其余 confirmed；`status.test.js` 前 3 例 |
| 8 | 整篇锁 vs 段落图比较 | `describeLockVsGraph`；installation 锁 1.0.0 vs 原文 1.1.0 → `lockFullyConsistent:false`；阅读器两种模型切换 |
| 9 | 来源缺失入口 | `source-missing`（p-legacy 删段后边仍在）：状态 + 冲突面板 + 左栏孤儿边区块 |
| 10 | 对齐冲突入口 | `detectAlignmentConflicts`：source/target-missing、duplicate-target、competing-proposal、dangling-unmap；UI 面板可定位/批准/驳回 |
| 11 | 人工确认入口 | `alignment_proposals` + `POST /proposals/:id/decision`；阅读器冲突面板按钮；`reviews.test.js` 第 3 例 |
| 12 | 章节重排 | 1.0.0→1.1.0 安装章前移：结构哈希变化、id 对齐不漂移、语义锚点跟随；`alignment.test.js` 第 2 例、`anchor.test.js` |
| 13 | 某语言暂缺 | Tag/en：200 + `targetAvailable:false` + reason，右栏占位；`status.test.js`「language missing」 |
| 14 | 代码更新 | registry demo v1→v2，审阅记录停在 v1 → `code-ref-changed`；正文无副本；`status.test.js` 第 4 例 |
| 15 | 两译者编辑同段 | `revision` + If-Match：第二提交 409、不覆盖、历史保留；`reviews.test.js` 第 1 例 + HTTP 集成测试 |
| 16 | 搜索进入历史版 | 命中带 docVersion；打开即归档视图并横幅声明；`search.test.js` 2 例 |
| 17 | 滚动尽量保持语义位置 | `anchor.remapAnchor` 三级回退（稳定id→标题序号→相似度，绝不像素）；`anchor.test.js` 4 例 |
| 18 | 页面明确翻译基于哪版原文 | 横幅 `翻译基线：…基于原文 X（最新 Y）`；历史版/过期锁各自有显式文案；SSR 已验证渲染 |
| 19 | 不把过期译文包装成完全同步 | 锁过期/有空缺/任何非 confirmed 状态 → `summary.inSync=false`（空译段不真空判同步） |

## 2. 测试结果

```
# tests 27
# pass 27
# fail 0
```

文件：`alignment.test.js`(3) `status.test.js`(8) `reviews.test.js`(3)
`anchor.test.js`(4) `search.test.js`(3) `api.test.js`(3) `scroll.test.js`(3)。

另做了真实 Vue SSR 渲染校验（Vite + plugin-vue 打包后 `renderToString`）：
button 1.1.0（含 1:2 标记、三类冲突、状态徽标、参数/代码引用）、Tag 英文暂缺、
button 1.0.0 历史归档横幅、installation 过期锁——四个分支全部渲染出预期内容。

## 3. 异常与边界

- **缺失语言不 404**：显式 `missing` 状态，避免把"暂缺"伪装成"已同步"。
- **冲突不自动裁决**：重复映射、竞争提案一律返回结构化 conflict 交人工。
- **并发不自动合并**：译文是译者文字，409 只提供 overwrite/rebase/open-diff。
- **代码引用缺失**：registry 找不到 ref → `code-ref-missing`，不渲染空代码。
- **历史视图不回写**：`getHistory` 是冻结快照，状态只反映被请求的版本。
