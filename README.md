# VitePress 文档系统 (Element Plus 风格)

本项目是一个基于 VitePress 搭建的高质量组件库文档模板，深度参考了 Element Plus 的交互体验与视觉风格。

## ✨ 特性

- 🚀 **自动化 Demo 提取**：使用 `::: demo` 语法自动读取 `.vue` 文件并生成预览与源码。
- 🌍 **内置国际化**：完善的中英文多语言切换支持。
- 🔍 **全文搜索**：集成 VitePress 本地搜索功能。
- 📊 **API 自动展示**：美观的组件属性（Attributes）表格。
- 🎨 **主题定制**：深度还原 Element Plus 的 UI 风格。

## 🌐 双语阅读（段落级语义对齐）

文档中心现已内置左右栏双语阅读器：按**语义节点（显式对齐图，非数组下标）**同步滚动，
支持中文段落一对多拆分、共享代码引用一致、翻译基线审阅状态、章节重排跟随、
历史版搜索、对齐冲突人工确认与整篇语言锁对比。

- 在线演示：`npm run docs:dev` 后访问 **/bilingual-demo**
- 内容 API：`npm run i18n:serve`（零依赖，http://localhost:5174/api/i18n）
- 逻辑测试：`npm run i18n:test`（27 用例）
- 设计说明：见 [`i18n/README.md`](./i18n/README.md)，SQL 建表见 `i18n/sql/schema.sql`

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
