// Stable content hashing — canonicalizes structured tokens so whitespace noise
// never masks an edit, but a single changed character flips the baseline.
//
// A segment is an array of tokens:
//   { kind: 'text',    text: '...' }
//   { kind: 'code-ref', ref: 'code:demo-button-v2' }          // shared code, NEVER copied into prose
//   { kind: 'param',    ref: 'param:type' }                   // parameter name, never translated
//   { kind: 'literal',  ref: 'lit:createApp' }                // do-not-translate marker
// Reference tokens carry NO inline copy: translators can't fork the code by
// accident, and a code update is detected centrally through the registry.

const FNV_OFFSET = 0x811c9dc5

export function fnv1a32(str) {
  let h = FNV_OFFSET >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // FNV prime; Math.imul keeps us in 32-bit space on every runtime.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Deterministic JSON: object keys sorted, no environment-dependent spacing.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

// Canonical segment text used BOTH for source baselines and target reviews,
// so "original changed?" and "review still matches stored translation?" share
// one definition. Text tokens are trimmed and blank ones dropped; reference
// tokens contribute their ref id (the content lives in the registry).
export function canonicalSegment(segment) {
  if (typeof segment === 'string') return segment.trim()
  return (segment || [])
    .map((tok) => {
      if (typeof tok === 'string') return tok.trim()
      if (tok.kind === 'text') return (tok.text || '').trim()
      return `⟨${tok.kind}:${tok.ref}⟩`
    })
    .filter(Boolean)
    .join(' ')
}

export function hashSegment(segment) {
  return fnv1a32(canonicalSegment(segment))
}

// A code-reference paragraph hashes against the CURRENT registry version, not
// the code body. Bumping the shared code flips every referring baseline at
// once — no prose copy to update, no silently stale copy.
export function codeRefFingerprint(ref, codeRegistry) {
  const entry = codeRegistry?.[ref]
  if (!entry) return `⟨code-ref:${ref}:MISSING⟩`
  return `⟨code-ref:${ref}@${entry.version}⟩`
}

export function hashCodeRef(ref, codeRegistry) {
  return fnv1a32(codeRefFingerprint(ref, codeRegistry))
}

// Full baseline for a document version: order-sensitive structural hash plus
// per-segment map. Structural hash detects chapter reordering even when every
// paragraph hash stays identical.
export function buildBaselines(version, registry = {}) {
  const segments = {}
  for (const seg of version.segments) {
    segments[seg.id] = segmentHash(seg, registry)
  }
  const structural = fnv1a32(
    version.segments
      .map((s) => `${s.id}:${s.type || 'prose'}:${segments[s.id]}`)
      .join('|')
  )
  return { docVersion: version.version, structural, segments }
}

export function segmentHash(seg, registry = {}) {
  if (seg.type === 'code-ref') return hashCodeRef(seg.ref || seg.codeRef, registry.code)
  return hashSegment(seg.tokens || seg.text)
}
