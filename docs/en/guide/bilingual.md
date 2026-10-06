# Bilingual Reading

The documentation center provides a side-by-side Chinese/English reader. Both panes scroll in sync by **semantic nodes**, not paragraph indices.

## Getting Started

```bash
npm run docs:seed   # Parse zh/en Markdown from docs/ into SQLite
npm run docs:server # Start the content API + reader at http://localhost:5174
```

## Features

- **Semantic alignment**: one Chinese paragraph may map to multiple English paragraphs; alignments live in a mapping table, never inferred from array indices
- **Translation baseline**: every translated segment records which source version it is based on; when the source changes, only affected segments are marked "needs review" while untouched ones stay "verified"
- **Shared code**: code blocks, parameter names and other untranslatable tokens reference a single shared source — translations never duplicate code
- **Language lock vs alignment graph**: the whole-document lock is continuously compared with the segment-level graph, so stale translations are never presented as fully in sync
- **Human-in-the-loop**: review confirmation, alignment-conflict resolution and document locking are all available in the reader
- **Historical versions**: search can hit historical versions, which are clearly labeled when opened

## Embedded Reader

<iframe src="http://localhost:5174" style="width:100%;height:640px;border:1px solid var(--vp-c-divider);border-radius:8px" title="Bilingual Reader"></iframe>

> Run `npm run docs:server` first for the embedded reader above to work.
