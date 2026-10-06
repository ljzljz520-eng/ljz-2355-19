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

## 🌍 双语对照阅读（新增）

文档中心支持中英双语对照阅读，左右栏按**语义节点**同步：

```bash
npm run docs:seed    # 解析 docs/ 中英文 Markdown 建库（SQLite）
npm run docs:server  # 内容 API + 阅读器 http://localhost:5174
npm test             # 场景测试（重排/缺语言/代码更新/并发/历史版等）
```

- 中文段落拆分后英文一对多对应，对齐关系存表而非数组下标
- 译文段落记录基于哪版原文；原文修改仅使相关译段待复核，未改段保留已验
- 代码块与参数名等不可翻译内容双语共享同一来源，译文不复制代码
- 整篇语言锁与段落级对齐图互相比对，过期译文不会被包装成「完全同步」
- 详见 `server/README.md` 与文档站「指南 → 双语对照阅读」

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
