// Semantic-node-driven synchronized scroll.
// We do NOT map pixel offsets 1:1 (panes have wildly different heights in 1:N
// cases). Instead, each side tracks which semantic node is currently at the
// anchor line, and scrolls the partner so the SAME node aligns there.

export function useSyncScroll() {
  let syncing = false

  function nodeAt(container, els, lineRatio = 0.15) {
    const line = container.scrollTop + container.clientHeight * lineRatio
    let best = null
    for (const el of els) {
      const top = el.offsetTop - container.offsetTop
      if (top <= line) best = { el, top }
    }
    return best
  }

  function makeHandler(self, partner, mapLeftToRightEls) {
    return () => {
      if (syncing) return
      syncing = true
      requestAnimationFrame(() => {
        const active = nodeAt(self, [...self.querySelectorAll('[data-segment-id]')])
        if (active) {
          const partnerEl = mapLeftToRightEls(active.el.dataset.segmentId)
          if (partnerEl) {
            const top = partnerEl.offsetTop - partner.offsetTop - partner.clientHeight * 0.15
            partner.scrollTo({ top, behavior: 'auto' })
          }
        }
        syncing = false
      })
    }
  }

  // Map selector uses group membership for 1:N: scrolling onto any member of a
  // group aligns the partner to the group's first member.
  function bind({ leftEl, rightEl, groupOf }) {
    const findTarget = (sourcePane, destPane, id) => {
      const group = groupOf(id)
      const ids = group ? group : [id]
      for (const candidate of ids) {
        const found = destPane.querySelector(`[data-segment-id="${cssEscape(candidate)}"]`)
        if (found) return found
      }
      return null
    }
    const onLeft = makeHandler(leftEl, rightEl, (id) => findTarget(leftEl, rightEl, id))
    const onRight = makeHandler(rightEl, leftEl, (id) => findTarget(rightEl, leftEl, id))
    leftEl.addEventListener('scroll', onLeft, { passive: true })
    rightEl.addEventListener('scroll', onRight, { passive: true })
    return () => {
      leftEl.removeEventListener('scroll', onLeft)
      rightEl.removeEventListener('scroll', onRight)
    }
  }

  return { bind }
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}
