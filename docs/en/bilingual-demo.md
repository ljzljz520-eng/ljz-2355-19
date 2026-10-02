# Docs Center · Bilingual Reader

A **live** paragraph-level bilingual reader backed by the content-API core in
`i18n/`. The left pane is the Chinese source, the right pane the English
translation; panes sync scroll on **semantic nodes** (explicit alignment edges),
never on array indexes.

## Try these scenarios

1. **Chapter reorder** — switch source `1.0.0 → 1.1.0`: Installation moves up; the anchor follows semantics.
2. **Missing language** — the second reader below shows Tag with English unavailable.
3. **Code update** — `c-demo-button` shared example moved v1 → v2; the paragraph is `code-ref-changed` and prose never carried a code copy.
4. **Two translators, same paragraph** — select a node → simulate the teammate → verify → **409 revision-conflict**.
5. **Search into history** — search `npm 安装`, open the 1.0.0 hit; the banner labels it a frozen archive.
6. **Conflict entry** — the Conflicts panel lists source-missing / target-missing / duplicate-target and pending proposals.
7. **Whole-doc lock vs paragraph graph** — compare modes; a stale lock (1.0.0 vs source 1.1.0) is never presented as in sync.

## Button doc (3 versions, 1:N mapping)

<BilingualReader doc-id="components/button" lang="en" source-version="1.1.0" />

## Installation doc (whole-document lock, stale baseline)

<BilingualReader doc-id="guide/installation" lang="en" source-version="1.1.0" />

## Tag doc (English missing)

<BilingualReader doc-id="components/tag" lang="en" source-version="1.0.0" />
