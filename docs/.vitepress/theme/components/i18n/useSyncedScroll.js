// 双栏按语义节点同步滚动。
// 关键：依据对齐图（pairs）建立 nid 映射，而不是 DOM 下标；
// 一对多（1:n / n:1）时取当前视口中心最近的“主动节点”，目标列滚动到其任一对应节点；
// 无对应节点时按 ord 找最近节点兜底，并标记 aligned=false（不强行滚动造成跳变）。
import { ref, onBeforeUnmount } from 'vue'

export function buildPairIndex(pairs) {
  const src2tgt = new Map()
  const tgt2src = new Map()
  for (const p of pairs) {
    if (!p.source || !p.target) continue
    push(src2tgt, p.source.nid, p.target.nid)
    push(tgt2src, p.target.nid, p.source.nid)
  }
  return { src2tgt, tgt2src }
}
function push(m, k, v) {
  if (!m.has(k)) m.set(k, [])
  m.get(k).push(v)
}

/**
 * @param getCols () => ({left: HTMLElement, right: HTMLElement})
 * @param indexRef  ref({src2tgt,tgt2src})
 * @param orderedRef ref({src:[nid...], tgt:[nid...]})
 */
export function useSyncedScroll(getCols, indexRef, orderedRef) {
  const anchor = ref({ lang: null, nid: null, aligned: true })
  let lockSide = null // 防止 scroll 事件互相反馈
  let lockUntil = 0
  let raf = 0

  const blockEls = (col, nid) => col.querySelector(`[data-nid="${cssEsc(nid)}"]`)
  const cssEsc = (s) => String(s).replace(/"/g, '\\"')

  const centerNid = (col, ordered) => {
    const top = col.scrollTop
    const mid = top + col.clientHeight / 2
    let best = null
    let bestDist = Infinity
    for (const el of col.querySelectorAll('[data-nid]')) {
      const d = Math.abs(el.offsetTop - mid)
      if (d < bestDist) {
        bestDist = d
        best = el.getAttribute('data-nid')
      }
    }
    return { nid: best, ordered }
  }

  const follow = (fromSide) => {
    const now = performance.now()
    if (lockSide && lockSide !== fromSide && now < lockUntil) return
    const cols = getCols()
    if (!cols.left || !cols.right) return
    const { src2tgt, tgt2src } = indexRef.value
    const { src, tgt } = orderedRef.value

    if (fromSide === 'left') {
      const { nid } = centerNid(cols.left, src)
      if (!nid) return
      const maps = src2tgt.get(nid)
      const target = chooseTarget(cols.right, maps, tgt)
      if (target.nid) {
        scrollToNode(cols.right, target.nid, target.aligned)
        anchor.value = { lang: 'en', nid: target.nid, aligned: target.aligned }
      }
      lockSide = 'left'
    } else {
      const { nid } = centerNid(cols.right, tgt)
      if (!nid) return
      const maps = tgt2src.get(nid)
      const target = chooseTarget(cols.left, maps, src)
      if (target.nid) {
        scrollToNode(cols.left, target.nid, target.aligned)
        anchor.value = { lang: 'zh', nid: target.nid, aligned: target.aligned }
      }
      lockSide = 'right'
    }
    lockUntil = now + 600
  }

  function chooseTarget(col, candidates, orderedFallback) {
    if (candidates?.length) {
      // 一对多：选离列中心最近的对应节点
      const mid = col.scrollTop + col.clientHeight / 2
      let best = null
      let bestDist = Infinity
      for (const nid of candidates) {
        const el = blockEls(col, nid)
        if (!el) continue
        const d = Math.abs(el.offsetTop - mid)
        if (d < bestDist) {
          bestDist = d
          best = nid
        }
      }
      if (best) return { nid: best, aligned: true }
    }
    // 无对齐：按最近 ord 兜底（语义位置近似，不按下标硬对）
    const mid = col.scrollTop + col.clientHeight / 2
    let best = null
    let bestDist = Infinity
    for (const nid of orderedFallback || []) {
      const el = blockEls(col, nid)
      if (!el) continue
      const d = Math.abs(el.offsetTop - mid)
      if (d < bestDist) {
        bestDist = d
        best = nid
      }
    }
    return { nid: best, aligned: false }
  }

  function scrollToNode(col, nid, aligned) {
    const el = blockEls(col, nid)
    if (!el) return
    // 对齐节点：与主动节点在各自列的相对视口位置保持一致（语义对齐而非顶部硬切）
    const target = el.offsetTop - col.clientHeight * 0.2
    lockSide = lockSide // 保持当前事件来源，避免回环
    col.scrollTo({ top: Math.max(0, target), behavior: aligned ? 'smooth' : 'auto' })
  }

  const onLeft = () => schedule('left')
  const onRight = () => schedule('right')
  function schedule(side) {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => follow(side))
  }

  /** 切换版本/搜索进入后，恢复到语义位置（nid 优先，ord 兜底） */
  function restoreAnchor(lang, nid) {
    requestAnimationFrame(() => {
      const cols = getCols()
      if (!cols.left) return
      const col = lang === 'en' ? cols.right : cols.left
      const other = lang === 'en' ? cols.left : cols.right
      const el = blockEls(col, nid)
      if (el) {
        col.scrollTop = Math.max(0, el.offsetTop - col.clientHeight * 0.2)
        follow(lang === 'en' ? 'right' : 'left')
      }
      anchor.value = { lang, nid, aligned: true }
      void other
    })
  }

  function bind(leftEl, rightEl) {
    leftEl?.addEventListener('scroll', onLeft, { passive: true })
    rightEl?.addEventListener('scroll', onRight, { passive: true })
  }
  function unbind(leftEl, rightEl) {
    leftEl?.removeEventListener('scroll', onLeft)
    rightEl?.removeEventListener('scroll', onRight)
  }

  onBeforeUnmount(() => cancelAnimationFrame(raf))

  return { anchor, bind, unbind, restoreAnchor }
}
