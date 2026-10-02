# VitePress 文档系统 (Element Plus 风格)

本项目是一个基于 VitePress 搭建的高质量组件库文档模板，深度参考了 Element Plus 的交互体验与视觉风格。

## ✨ 特性

- 🚀 **自动化 Demo 提取**：使用 `::: demo` 语法自动读取 `.vue` 文件并生成预览与源码。
- 🌍 **内置国际化**：完善的中英文多语言切换支持。
- 🔍 **全文搜索**：集成 VitePress 本地搜索功能。
- 📊 **API 自动展示**：美观的组件属性（Attributes）表格。
- 🎨 **主题定制**：深度还原 Element Plus 的 UI 风格。

## 🚀 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发服务器

```bash
npm run docs:dev
```

### 3. 构建静态站点

```bash
npm run docs:build
```

### 4. 预览构建效果

```bash
npm run docs:preview
```

## 📂 项目结构

- `docs/`：文档根目录
  - `.vitepress/`：配置与主题
  - `components/`：组件说明文档
  - `examples/`：存放所有的组件 Demo 示例代码
  - `guide/`：入门指南

## 🛠 语法说明

### 组件示例

使用 `::: demo [描述文本]` 块，并在其中写入示例文件的路径：

```markdown
::: demo 基础按钮用法
examples/button/basic.vue
:::
```


---

## 🌐 文档中心双语阅读（语义节点对齐）

除常规中英文站点外，本项目实现了独立的**双语对照阅读系统**：
左右双栏按**语义节点图**同步（非数组下标），支持中文一段 ↔ 英文多段；
内容 API 提供语言版本与对应关系，SQL 保存翻译基线与审阅状态。

- 阅读入口：`/bilingual/quickstart`、历史版 `/bilingual/quickstart-history-v1`、语言暂缺 `/bilingual/faq`
- 详细设计与 API：[`i18n/README.md`](./i18n/README.md)

```bash
npm test                # 39 个测试（解析/对齐图/状态机/锁/HTTP/前端内核）
npm run i18n:reset      # 建库 + 播种历史版 + 生成静态快照
npm run i18n:serve      # 内容 API :5174（dev 已配 /api 代理）
npm run docs:dev        # 文档站
```

核心特性：章节重排不丢已验状态、原文修改仅相关译段待复核、共享代码 codeRef 不复制、
参数名/`[[keep]]` 受保护校验、整篇语言锁 vs 段落锁、两译者同段乐观冲突、
来源缺失/对齐冲突的人工确认入口、搜索可进入历史版并保持语义滚动位置、
页面明确标注译文所基于的原文版本，不把过期译文呈现为完全同步。
