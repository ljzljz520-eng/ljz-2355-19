# Quick Start

<!-- i18n:id=intro xref=intro -->
This section explains how to use My Component Lib in your project and get your first component running in three minutes.

## Installation

<!-- i18n:id=install-desc xref=install-desc -->
We recommend installing with a package manager. You can also use a CDN.

<!-- i18n:id=install-code code=install-npm lang=bash -->
```bash
npm install my-component-lib
```

## Basic Usage

<!-- i18n:id=usage-desc xref=usage-desc -->
Call `createApp` in your entry file and register `MyComponentLib`; the parameter name `options` stays unchanged and [[keep:MyComponentLib]] is never translated.

<!-- i18n:id=usage-code code=usage-app lang=javascript -->
```javascript
import { createApp } from 'vue'
import MyComponentLib from 'my-component-lib'

const app = createApp(App)
app.use(MyComponentLib, { options: {} })
app.mount('#app')
```

<!-- 中文一段被拆成两个英文段：两条边指向同一 src_nid，而非按下标对齐 -->
<!-- i18n:id=en-import-modes-1 xref=import-modes -->
Components support on-demand import.

<!-- i18n:id=en-import-modes-2 xref=import-modes -->
You can also register a single component to reduce your bundle size.

## Next Steps

<!-- i18n:id=next xref=next -->
Read the components chapter for the full API reference.
