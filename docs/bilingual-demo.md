# 文档中心 · 双语阅读

下面是一个**真实运行**的段落级双语阅读器，直接连接本仓库 `i18n/` 中的内容 API 核心逻辑与示例数据。
左栏为中文原文，右栏为英文译文；两栏按**语义节点**（显式对齐边）同步滚动，而不是按数组下标。

## 尝试这些场景

1. **章节重排**：切换原文版本 `1.0.0 → 1.1.0`，"安装"章节前移；定位锚点跟随语义节点而非行号。
2. **某语言暂缺**：在文档下拉中无法切换（本页固定 Button 文档）；可通过下面第二个阅读器查看 Tag 文档的英文暂缺状态。
3. **代码更新**：`c-demo-button` 引用的共享示例已从 v1 升到 v2，对应段落标为 `code-ref-changed`，正文从未复制代码。
4. **两译者编辑同段**：点选任意段落 → "模拟另一译者同时编辑此段" → 再点"验证通过"，得到 **409 revision-conflict**。
5. **搜索进入历史版**：搜索框输入 `npm 安装`，点击 1.0.0 版本命中，页面顶部明确标注"历史版本归档"。
6. **对齐冲突入口**：右上角"对齐冲突"面板列出 source-missing / target-missing / duplicate-target 与待决提案，可逐条定位与批准/驳回。
7. **整篇语言锁 vs 段落图**：切换"整篇语言锁"模型查看 installation 文档（见下）——锁基线 1.0.0 落后于原文 1.1.0，不被包装成完全同步。

## Button 文档（默认，含 3 个版本与 1:N 对齐）

<BilingualReader doc-id="components/button" lang="en" source-version="1.1.0" />

## Installation 文档（整篇语言锁，基线过期）

英文译文整篇锁定在原文 1.0.0，而原文已更新到 1.1.0。切换右上"整篇语言锁"模型可看到对比结论：**锁不允许部分同步，过期就是整篇过期**。

<BilingualReader doc-id="guide/installation" lang="en" source-version="1.1.0" />

## Tag 文档（英文暂缺）

<BilingualReader doc-id="components/tag" lang="en" source-version="1.0.0" />
