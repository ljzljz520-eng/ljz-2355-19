// Shared registry: code, parameter names and do-not-translate literals live
// exactly ONCE here. Both languages reference them by id; translators cannot
// fork a copy, so updating shared code bumps a version and every referring
// paragraph is flagged centrally.
export const registry = {
  code: {
    // v1 shipped with 1.0.0 docs; v2 is the "code update" scenario: same ref id,
    // new body + version. Prose translations stay untouched and linked.
    'code:demo-button': {
      version: 2,
      language: 'vue',
      filename: 'examples/button/basic.vue',
      history: [
        {
          version: 1,
          body: `<template>
  <div class="demo-button">
    <BaseButton>Default</BaseButton>
    <BaseButton type="primary">Primary</BaseButton>
  </div>
</template>`
        },
        {
          version: 2,
          body: `<template>
  <div class="demo-button">
    <BaseButton>Default</BaseButton>
    <BaseButton type="primary">Primary</BaseButton>
    <BaseButton type="primary" size="small">Small</BaseButton>
  </div>
</template>`
        }
      ],
      body: `<template>
  <div class="demo-button">
    <BaseButton>Default</BaseButton>
    <BaseButton type="primary">Primary</BaseButton>
    <BaseButton type="primary" size="small">Small</BaseButton>
  </div>
</template>`
    }
  },
  params: {
    'param:type': { name: 'type', description: { zh: '按钮类型', en: 'button type' } },
    'param:size': { name: 'size', description: { zh: '尺寸', en: 'size' } }
  },
  literals: {
    // do-not-translate marker: rendered identically in every language version
    'lit:createApp': { text: 'createApp' }
  }
}
