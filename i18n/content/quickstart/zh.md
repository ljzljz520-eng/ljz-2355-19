# 快速开始

<!-- i18n:id=intro -->
本节介绍如何在项目中使用 My Component Lib，并用三分钟跑通第一个组件。

## 安装

<!-- i18n:id=install-desc -->
我们建议使用包管理器安装，也可以通过 CDN 引入。

<!-- i18n:id=install-code code=install-npm lang=bash -->
```bash
npm install my-component-lib
```

## 基础用法

<!-- i18n:id=usage-desc -->
在入口文件中调用 `createApp`，并注册 `MyComponentLib`；参数名 `options` 保持不变，[[keep:MyComponentLib]] 不需要翻译。

<!-- i18n:id=usage-code code=usage-app lang=javascript -->
```javascript
import { createApp } from 'vue'
import MyComponentLib from 'my-component-lib'

const app = createApp(App)
app.use(MyComponentLib, { options: {} })
app.mount('#app')
```

<!-- i18n:id=import-modes -->
组件支持按需引入，你也可以只注册单个组件以减小打包体积。

## 下一步

<!-- i18n:id=next -->
阅读组件章节了解全部 API。
