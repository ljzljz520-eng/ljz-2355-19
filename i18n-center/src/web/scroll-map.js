/**
 * 语义滚动映射（纯函数，可单测；前端 app.js 用同一逻辑）。
 *
 * 不按像素绝对值或数组下标对齐，而是：
 *   1) 找到源列「视口中心」所在的语义节点 anchor；
 *   2) 通过它所属的对齐组 id，在目标列找到对应节点；
 *   3) 返回应施加的 scrollTop 增量，使目标节点居中。
 * 章节重排/1:N 时，只要组还在，就能落到同一语义位置（而非同一像素）。
 *
 * @param {{id:string,top:number,height:number}[]} srcRects  源列节点（id=组id）
 * @param {{id:string,top:number,height:number}[]} tgtRects  目标列节点（同组可能多个）
 * @param {{scrollTop:number,viewportTop:number,clientHeight:number,scrollHeight:number}} src
 * @param {{scrollTop:number,clientHeight:number,scrollHeight:number}} tgt
 * @returns {{delta:number,groupId:string}|null}
 */
export function mapScroll(srcRects, tgtRects, src, tgt) {
  const centerY = src.viewportTop + src.clientHeight / 2
  let anchor = null; let best = Infinity
  for (const n of srcRects) {
    const c = n.top + n.height / 2
    const d = Math.abs(c - centerY)
    if (d < best) { best = d; anchor = n }
  }
  if (!anchor) return null
  const groupId = anchor.id
  const partners = tgtRects.filter((n) => n.id === groupId)
  if (!partners.length) return null
  // 取目标组中最靠近中心的节点
  const tgtCenter = tgt.clientHeight / 2
  let target = partners[0]; let bt = Infinity
  for (const n of partners) {
    const d = Math.abs(n.top + n.height / 2 - tgtCenter)
    if (d < bt) { bt = d; target = n }
  }
  let delta = (target.top + target.height / 2) - tgtCenter
  const maxScroll = Math.max(0, tgt.scrollHeight - tgt.clientHeight)
  const projected = Math.min(maxScroll, Math.max(0, tgt.scrollTop + delta))
  return { delta: projected - tgt.scrollTop, groupId }
}
