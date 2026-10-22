/**
 * venue 白名单归一（§7 FR-16.1 / §8 R14.7）。
 *
 * 只做**确定性字符串归一**，不做模糊匹配——「宁可漏，不可错」。
 * 归一后**精确相等**才算命中：`NeurIPS` 与 `NIPS` 这类历史改名不会互相命中，
 * 这是有意的（模糊匹配会把 ACL 与 ACL-IJCNLP 之类混在一起）。
 *
 * @module paper-algo-radar/venue
 */

/** 常见的「会议论文集」前缀，可重复剥离。 */
const PROCEEDINGS_PREFIX = /^(?:in\s+)?(?:proceedings|proc\.?)\s+of\s+(?:the\s+)?/i
/** 出版方前缀：IEEE / IEEE/CVF / IEEE/ACM / ACM/IEEE / CVF。 */
const PUBLISHER_PREFIX = /^(?:ieee(?:\s*\/\s*(?:cvf|acm))?|acm\s*\/\s*ieee|cvf)\s+/i

/**
 * 归一 venue 名：剥离年份 / 卷期 / 页码 / `Proceedings of` / `IEEE` 前缀，统一大写。
 *
 * @param {string} value 原始 venue（可能来自 Crossref / 手工填写）
 * @returns {string|null} 归一结果；空 / 纯空白 / 剥完为空 → `null`（调用方记 `venue-missing`）
 */
export function normalizeVenue(value) {
  let text = String(value ?? '')
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return null

  // 前缀可能叠加（"In Proceedings of the IEEE/CVF CVPR"），循环剥到稳定
  for (let i = 0; i < 4; i += 1) {
    const before = text
    text = text.replace(PROCEEDINGS_PREFIX, '').replace(PUBLISHER_PREFIX, '')
    if (text === before) break
  }

  // 卷 / 期 / 页码 / 括号里的期号
  text = text
    .replace(/[,;]?\s*(?:vol\.?|volume)\s*\d+/gi, '')
    .replace(/[,;]?\s*(?:no\.?|issue)\s*\d+/gi, '')
    .replace(/[,;]?\s*pp?\.\s*\d+\s*[-–—]\s*\d+/gi, '')
    .replace(/\s*\(\s*\d+\s*\)\s*/g, ' ')
    // 独立年份（1900–2099）
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')

  const normalized = text
    .replace(/[,\s;:]+/g, ' ')
    .trim()
    .toUpperCase()
  return normalized === '' ? null : normalized
}

/** 白名单 → 归一集合（空项丢弃）。 */
export function allowlistSet(list) {
  const set = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const normalized = normalizeVenue(item)
    if (normalized !== null) set.add(normalized)
  }
  return set
}

/**
 * 判断一个 venue 是否在白名单内。
 * 空 venue 永远不命中（没有 venue 就无从判断，不猜）。
 */
export function venueInAllowlist(venue, allowlist) {
  const normalized = normalizeVenue(venue)
  if (normalized === null) return false
  return allowlistSet(allowlist).has(normalized)
}

/** 候选标注文案（FR-16.2：未命中要显式标注，不静默丢弃）。 */
export function venueMatchLabel(matched) {
  return matched ? '白名单内' : '不在白名单'
}
