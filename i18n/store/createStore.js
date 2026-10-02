// In-memory review/proposal store used by the HTTP API and the VitePress demo.
// The SQL schema (i18n/sql/schema.sql) is the durable version of these tables;
// this module implements the same operations transactionally in JS so the
// whole system runs without a database for development and tests.

export function createStore(seed) {
  const reviews = {}
  for (const r of seed?.reviews || []) {
    reviews[`${r.docId}::${r.lang}::${r.unitId}`] = { ...r }
  }
  return {
    docs: structuredClone(seed?.docs || []),
    registry: structuredClone(seed?.registry || { code: {}, params: {}, literals: {} }),
    reviews,
    proposals: structuredClone(seed?.proposals || []),
    history: []
  }
}
