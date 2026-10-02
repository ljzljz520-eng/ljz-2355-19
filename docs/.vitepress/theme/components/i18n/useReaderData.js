// 数据获取：优先内容 API（Vite dev 代理 / 显式 base），失败回退构建期快照 JSON。
// 两种来源结构一致（均由 getReader 装配），绝不因为拿不到 API 就伪造“完全同步”。
import { ref, computed } from 'vue'

const SNAPSHOT_BASE = '/i18n' // docs/public/i18n

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    let body = {}
    try {
      body = await res.json()
    } catch {}
    const err = new Error(body?.error?.message || `HTTP ${res.status}`)
    err.status = res.status
    err.code = body?.error?.code
    throw err
  }
  return res.json()
}

export function useReaderData(docId) {
  const data = ref(null)
  const loading = ref(true)
  const error = ref(null)
  const source = ref(null) // 'api' | 'snapshot'
  const srcVersion = ref(null)
  const tgtVersion = ref(null)

  async function load(qs = {}) {
    loading.value = true
    error.value = null
    const params = new URLSearchParams()
    if (qs.srcLang) params.set('srcLang', qs.srcLang)
    if (qs.tgtLang) params.set('tgtLang', qs.tgtLang)
    if (qs.srcVersion != null) params.set('srcVersion', qs.srcVersion)
    if (qs.tgtVersion != null) params.set('tgtVersion', qs.tgtVersion)
    const query = params.toString()
    const apiUrl = `/api/reader/${encodeURIComponent(docId)}${query ? `?${query}` : ''}`
    try {
      try {
        data.value = await fetchJson(apiUrl)
        source.value = 'api'
      } catch (apiErr) {
        if (apiErr.status === 404) throw apiErr // 文档真的不存在
        // API 不可用时回退构建期快照：当前版用 reader.json，历史版用 vN.reader.json
        const file =
          qs.srcVersion != null
            ? `${SNAPSHOT_BASE}/${encodeURIComponent(docId)}/v${qs.srcVersion}.reader.json`
            : `${SNAPSHOT_BASE}/${encodeURIComponent(docId)}/reader.json`
        data.value = await fetchJson(file)
        source.value = 'snapshot'
      }
    } catch (e) {
      error.value = e
      data.value = null
    } finally {
      loading.value = false
      srcVersion.value = data.value?.srcVersion ?? null
      tgtVersion.value = data.value?.tgtVersion ?? null
    }
  }

  return { data, loading, error, source, srcVersion, tgtVersion, load }
}

/**
 * 搜索：优先内容 API（可跨文档、支持任意版本）；失败则在构建期快照内本地检索，
 * 命中历史版本时返回对应 version，供前端打开历史版并滚动到语义节点。
 */
export async function searchI18n(q, lang = 'zh', version = null, docId = null) {
  try {
    const params = new URLSearchParams({ q, lang })
    if (version) params.set('version', version)
    if (docId) params.set('docId', docId)
    return await fetchJson(`/api/search?${params.toString()}`)
  } catch (apiErr) {
    if (apiErr.status === 404) throw apiErr
    const index = docId
      ? [{ id: docId }]
      : (await fetchJson(`${SNAPSHOT_BASE}/docs.json`)).docs
    const hits = []
    for (const d of index) {
      const versions = await fetchJson(`${SNAPSHOT_BASE}/${d.id}/versions.json`)
      const vers = (versions.snapshotVersions || []).filter((v) => !version || v === version)
      for (const v of vers) {
        const r = await fetchJson(`${SNAPSHOT_BASE}/${d.id}/v${v}.reader.json`)
        const nodes = r.columns?.source || []
        for (const n of nodes) {
          if (n.content?.includes(q)) {
            hits.push({
              docId: d.id,
              docTitle: r.doc?.title,
              lang: r.srcLang,
              version: v,
              nid: n.nid,
              ord: n.ord,
              kind: n.kind,
              snippet: n.content.replace(/\s+/g, ' ').slice(0, 160)
            })
          }
        }
      }
    }
    return { query: q, lang, version: version ?? 'current(snapshot)', hits }
  }
}
