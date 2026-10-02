import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument } from '../src/parser.js'

test('显式 id 与 xref：节点身份不依赖下标', () => {
  const zh = parseDocument(
    `# T\n\n<!-- i18n:id=a -->\n你好\n\n<!-- i18n:id=b -->\n世界\n`,
    'zh'
  )
  assert.equal(zh.blocks[0].nid.startsWith('sec-'), true)
  assert.deepEqual(zh.blocks.map((b) => b.nid).slice(1), ['a', 'b'])
  const en = parseDocument(
    `# T\n\n<!-- i18n:xref=b -->\nworld\n\n<!-- i18n:xref=a -->\nhello\n`,
    'en'
  )
  // 即使英文段顺序与中文相反，xref 仍明确指向正确节点（过滤标题块）
  const enParas = en.blocks.filter((b) => b.kind !== 'heading')
  assert.deepEqual(enParas.map((b) => b.xrefs[0]), ['b', 'a'])
})

test('中文一段对应英文两段：同一 xref 可重复', () => {
  const en = parseDocument(
    `<!-- i18n:xref=split -->\nA\n\n<!-- i18n:xref=split -->\nB\n`,
    'en'
  )
  assert.equal(en.blocks[0].xrefs[0], 'split')
  assert.equal(en.blocks[1].xrefs[0], 'split')
})

test('共享代码块走 codeRef，正文内容不复制引用关系', () => {
  const md = `<!-- i18n:id=install-code code=install-npm lang=bash -->\n\`\`\`bash\nnpm i x\n\`\`\`\n`
  const r = parseDocument(md, 'zh')
  const code = r.blocks.find((b) => b.kind === 'code')
  assert.equal(code.codeRef, 'install-npm')
  assert.equal(r.codeRefs[0].name, 'install-npm')
  assert.match(r.codeRefs[0].content, /npm i x/)
})

test('标题自动 nid：英文 slug、中文哈希 slug（稳定可复现）', () => {
  const en = parseDocument(`## Basic Usage\n`, 'en')
  assert.equal(en.blocks[0].nid, 'basic-usage')
  const zh1 = parseDocument(`## 基础用法\n`, 'zh')
  const zh2 = parseDocument(`## 基础用法\n`, 'zh')
  assert.match(zh1.blocks[0].nid, /^sec-[0-9a-f]{8}$/)
  assert.equal(zh1.blocks[0].nid, zh2.blocks[0].nid)
})

test('普通隐式段落标记 nid_auto（不参与隐式对齐猜测）', () => {
  const r = parseDocument(`没有标记的段落\n`, 'zh')
  assert.equal(r.blocks[0].nidAuto, 1)
})
