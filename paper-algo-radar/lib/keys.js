/**
 * 论文键（§9.2）与 DOI / arXiv 归一。
 *
 * 独立成模块是为了让 `index.js` 与 `migrate.js` 共用同一份口径，
 * 又不产生循环依赖（migrate 不能 import index）。
 *
 * @module paper-algo-radar/keys
 */
import { createHash, randomBytes } from 'node:crypto'

const PAPER_ID = /^p_[0-9a-f]{16}$/

export function digest(text, length = 16) {
  return createHash('sha1').update(text).digest('hex').slice(0, length)
}

/** 新论文主键：`p_<16hex>`。 */
export function newPaperId() {
  return `p_${randomBytes(8).toString('hex')}`
}

/** 现有 id 是否合法（v0.2 的形态）；不合法则迁移时换新。 */
export function isValidPaperId(id) {
  return typeof id === 'string' && PAPER_ID.test(id)
}

/** 标题规范化：NFKC → trim → 折叠空白 → 小写，取 sha1 前 16 位（§10.1 迁移器口径）。 */
export function normalizeTitleKey(title) {
  const normalized = String(title ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (normalized === '') return ''
  return digest(normalized, 16)
}

/** v0.2 的 `doi` 位可能塞的是 arXiv id（工具描述就是这么约定的），要分开认。 */
export function looksLikeArxiv(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return false
  return (
    /^arxiv:/i.test(raw) ||
    /arxiv\.org\/(abs|pdf)\//i.test(raw) ||
    /^\d{4}\.\d{4,5}(v\d+)?$/.test(raw)
  )
}

export function normalizeArxivId(value) {
  let raw = String(value ?? '').trim()
  if (raw === '') return ''
  raw = raw
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:/i, '')
  return raw.toLowerCase()
}

export function normalizeDoi(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '') return ''
  return raw.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
}

/** 一篇论文的可用键，按优先序返回（doi > arxiv > title）。 */
export function paperKeysOf(paper) {
  const keys = []
  if (paper && paper.doi) keys.push('doi:' + paper.doi)
  if (paper && paper.arxivId) keys.push('arxiv:' + paper.arxivId)
  if (paper && paper.title) {
    const titleKey = normalizeTitleKey(paper.title)
    if (titleKey !== '') keys.push('title:' + titleKey)
  }
  return keys
}
