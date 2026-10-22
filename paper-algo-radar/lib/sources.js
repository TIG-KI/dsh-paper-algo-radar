/**
 * 第三方检索与解析（§7 FR-6.2 / FR-1.7 / P-7）。
 *
 * 插件自带的三个客户端：OpenAlex、Crossref、arXiv。
 *  - 并发执行，**单个源失败不影响其它源**（结果里逐源报告 ok/failed + 原因）。
 *  - 合并后按 DOI、其次按标题去重。
 *  - 端点可注入：测试用本地假服务器，不碰真网络。
 *
 * @module paper-algo-radar/sources
 */

import { fetchJson, fetchText } from './net.js'
import { normalizeDoi, normalizeTitleKey } from './keys.js'

const ENDPOINTS = {
  openalex: 'https://api.openalex.org/works',
  crossref: 'https://api.crossref.org/works',
  arxiv: 'https://export.arxiv.org/api/query',
}

/** 抓全文的候选基址（按顺序尝试）。 */
let fulltextBases = ['https://arxiv.org/html/', 'https://ar5iv.labs.arxiv.org/html/']

export function setEndpoints(overrides = {}) {
  Object.assign(ENDPOINTS, overrides)
}

export function resetEndpoints() {
  ENDPOINTS.openalex = 'https://api.openalex.org/works'
  ENDPOINTS.crossref = 'https://api.crossref.org/works'
  ENDPOINTS.arxiv = 'https://export.arxiv.org/api/query'
  fulltextBases = ['https://arxiv.org/html/', 'https://ar5iv.labs.arxiv.org/html/']
}

export function setFulltextBases(bases) {
  fulltextBases = [...bases]
}

/** OpenAlex 的摘要存在倒排索引里，按 position 复原。 */
export function abstractFromInvertedIndex(index) {
  if (index === null || typeof index !== 'object') return ''
  const slots = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) {
      if (typeof position === 'number') slots[position] = word
    }
  }
  return slots.filter((word) => typeof word === 'string').join(' ').trim()
}

function yearOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const match = /(\d{4})/.exec(String(value ?? ''))
  return match ? Number(match[1]) : null
}

/** 元数据里常见的 HTML 实体（Crossref 标题里经常带 &amp;）。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 去掉 JATS/HTML 标签并解码实体。 */
function plainText(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]+>/g, ' '))
}

/** OpenAlex 支持服务端年份与引用数过滤。 */
function openAlexFilter({ yearFrom, yearTo, minCitations }) {
  const parts = []
  if (yearFrom !== null) parts.push(`from_publication_date:${yearFrom}-01-01`)
  if (yearTo !== null) parts.push(`to_publication_date:${yearTo}-12-31`)
  // OpenAlex 没有 >= 语法，用 > (min - 1) 表达「至少 min 次」
  if (minCitations !== null) parts.push(`cited_by_count:>${Math.max(0, minCitations - 1)}`)
  return parts.length > 0 ? `&filter=${parts.join(',')}` : ''
}

/** Crossref 支持服务端年份过滤；引用数只能取回后本地过滤。 */
function crossrefFilter({ yearFrom, yearTo }) {
  const parts = []
  if (yearFrom !== null) parts.push(`from-pub-date:${yearFrom}-01-01`)
  if (yearTo !== null) parts.push(`until-pub-date:${yearTo}-12-31`)
  return parts.length > 0 ? `&filter=${parts.join(',')}` : ''
}

/** arXiv 用 submittedDate 区间过滤；不提供引用数。 */
function arxivDateClause({ yearFrom, yearTo }) {
  if (yearFrom === null && yearTo === null) return ''
  const from = `${yearFrom ?? 1991}01010000`
  const to = `${yearTo ?? 2100}12312359`
  return `+AND+submittedDate:${encodeURIComponent(`[${from} TO ${to}]`)}`
}

async function searchOpenAlex(query, limit, options = {}) {
  const url =
    `${ENDPOINTS.openalex}?search=${encodeURIComponent(query)}` +
    `&per-page=${limit}&select=id,doi,title,publication_year,primary_location,cited_by_count,abstract_inverted_index` +
    openAlexFilter(options)
  const data = await limitedFetch('openalex:' + url, 'openalex', () => fetchJson(url, { timeoutMs: 12000 }))
  const results = Array.isArray(data?.results) ? data.results : []
  return results.map((item) => ({
    title: String(item?.title ?? '').trim(),
    year: yearOf(item?.publication_year),
    venue: String(item?.primary_location?.source?.display_name ?? '').trim(),
    doi: normalizeDoi(item?.doi),
    arxivId: '',
    url: String(item?.id ?? ''),
    abstract: abstractFromInvertedIndex(item?.abstract_inverted_index),
    citations: Number(item?.cited_by_count ?? 0) || 0,
    source: 'openalex',
  }))
}

async function searchCrossref(query, limit, options = {}) {
  const url =
    `${ENDPOINTS.crossref}?query=${encodeURIComponent(query)}&rows=${limit}` +
    `&select=DOI,title,issued,container-title,is-referenced-by-count,abstract,URL` +
    crossrefFilter(options)
  const data = await limitedFetch('crossref:' + url, 'crossref', () => fetchJson(url, { timeoutMs: 12000 }))
  const results = Array.isArray(data?.message?.items) ? data.message.items : []
  return results.map((item) => ({
    title: plainText(Array.isArray(item?.title) ? item.title[0] : item?.title),
    year: yearOf(item?.issued?.['date-parts']?.[0]?.[0]),
    venue: plainText(Array.isArray(item?.['container-title']) ? item['container-title'][0] : ''),
    doi: normalizeDoi(item?.DOI),
    arxivId: '',
    url: String(item?.URL ?? ''),
    abstract: plainText(item?.abstract),
    citations: Number(item?.['is-referenced-by-count'] ?? 0) || 0,
    source: 'crossref',
  }))
}

/** 解析 arXiv 的 Atom 返回（不引 XML 库，按 entry 切块 + 取标签）。 */
export function parseArxivAtom(xml) {
  const text = String(xml ?? '')
  const entries = []
  const blocks = text.split(/<entry[\s>]/).slice(1)
  for (const block of blocks) {
    const pick = (tag) => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
      return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    }
    const id = pick('id')
    const arxivId = /abs\/([^<\s]+)$/.exec(id)?.[1] ?? ''
    entries.push({
      title: pick('title'),
      year: yearOf(pick('published')),
      venue: 'arXiv',
      doi: '',
      arxivId,
      url: id,
      abstract: pick('summary'),
      // arXiv API 不提供引用数；null 表示「未知」，不是 0
      citations: null,
      source: 'arxiv',
    })
  }
  return entries
}

async function searchArxiv(query, limit, options = {}) {
  const url =
    `${ENDPOINTS.arxiv}?search_query=all:${encodeURIComponent(query)}${arxivDateClause(options)}` +
    `&start=0&max_results=${limit}`
  const xml = await limitedFetch('arxiv:' + url, 'arxiv', () => fetchText(url, { timeoutMs: 12000 }))
  return parseArxivAtom(xml)
}

const CLIENTS = {
  openalex: searchOpenAlex,
  crossref: searchCrossref,
  arxiv: searchArxiv,
}

export const SOURCE_NAMES = Object.keys(CLIENTS)

/* ------------------------------------------------------------------ *
 * 出站限速与缓存（§8 R10 / §13.2 / FR-6.10）
 *
 * - 每个主机一个最小间隔，避免并发三源时把配额打光
 * - 5 分钟内存缓存，同一查询重复点「刷新」不重复出站
 * - 两者都**可注入**（测试里把间隔设 0、TTL 设 1ms）
 * ------------------------------------------------------------------ */

let minIntervalMs = 300
const lastCallAt = new Map()
let cacheTtlMs = 5 * 60_000
const cache = new Map()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function configureThrottle({ intervalMs, ttlMs } = {}) {
  if (Number.isFinite(Number(intervalMs))) minIntervalMs = Math.max(0, Number(intervalMs))
  if (Number.isFinite(Number(ttlMs))) cacheTtlMs = Math.max(0, Number(ttlMs))
}

export function clearSourceCache() {
  cache.clear()
  lastCallAt.clear()
}

export function cacheStats() {
  return { size: cache.size, ttlMs: cacheTtlMs, intervalMs: minIntervalMs }
}

/** 对某个主机做最小间隔节流。 */
async function throttle(host) {
  if (minIntervalMs <= 0) return
  const last = lastCallAt.get(host) ?? 0
  const wait = last + minIntervalMs - Date.now()
  if (wait > 0) await sleep(wait)
  lastCallAt.set(host, Date.now())
}

/** 带缓存与节流的抓取；`key` 相同的请求在 TTL 内直接复用。 */
async function limitedFetch(key, host, fn) {
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < cacheTtlMs) {
    return hit.value
  }
  await throttle(host)
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  // 简单上限，避免内存无限增长
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest !== undefined) cache.delete(oldest[0])
  }
  return value
}

/**
 * 合并多个源的结果。
 *
 * 两遍匹配，解决「一个源有 DOI、另一个源没有」这类最常见的重复：
 *  1. 有条目带 DOI 且已见过同 DOI → 合并；
 *  2. 否则按规范化标题找已有条目 → 合并（并顺手补上 DOI）。
 *
 * 两个**不同的非空 DOI** 永远不会因为标题相同而被合并——同名不同篇是真实存在的。
 */
export function mergeItems(groups) {
  const merged = []
  const byDoi = new Map()
  const byTitle = new Map()

  for (const group of groups) {
    for (const item of group.items ?? []) {
      const titleKey = normalizeTitleKey(item.title)
      let existing
      if (item.doi !== '') existing = byDoi.get(item.doi)
      if (existing === undefined && titleKey !== '') existing = byTitle.get(titleKey)

      if (existing === undefined) {
        const copy = { ...item, sources: [item.source] }
        merged.push(copy)
        if (copy.doi !== '') byDoi.set(copy.doi, copy)
        if (titleKey !== '') byTitle.set(titleKey, copy)
        continue
      }

      existing.sources = [...new Set([...existing.sources, item.source])]
      if (existing.year === null && item.year !== null) existing.year = item.year
      if (!existing.venue && item.venue) existing.venue = item.venue
      if (!existing.arxivId && item.arxivId) existing.arxivId = item.arxivId
      if (!existing.abstract && item.abstract) existing.abstract = item.abstract
      if ((existing.citations ?? 0) < (item.citations ?? 0)) existing.citations = item.citations
      if (item.doi !== '' && existing.doi === '') {
        existing.doi = item.doi
        byDoi.set(item.doi, existing)
      }
      if (titleKey !== '' && !byTitle.has(titleKey)) byTitle.set(titleKey, existing)
    }
  }
  return merged
}

/** 年份必须在合理区间；只接受整数，其余当「没传」。 */
function filterYear(value) {
  const year = Number(value)
  if (!Number.isFinite(year)) return null
  const whole = Math.trunc(year)
  return whole >= 1000 && whole <= 3000 ? whole : null
}

/**
 * 归一化检索过滤条件（年份区间 + 最低引用数）。
 * - 年份只接受 1000–3000 的整数；from > to 时自动交换；
 * - `minCitations` 只在 > 0 时生效；0 / 空表示不过滤；
 * - 无效值当「没传」，不报错（候选是检索结果，不值得为过滤参数中断）。
 */
export function normalizeDiscoverFilters(options = {}) {
  let yearFrom = filterYear(options.yearFrom)
  let yearTo = filterYear(options.yearTo)
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    const swap = yearFrom
    yearFrom = yearTo
    yearTo = swap
  }
  const rawMin = Number(options.minCitations)
  const minCitations = Number.isFinite(rawMin) && rawMin > 0 ? Math.trunc(rawMin) : null
  return { yearFrom, yearTo, minCitations }
}

/**
 * 在合并后的候选上应用年份 / 引用数过滤。
 * 口径：年份或引用数**未知**时，只要启用了对应过滤就剔除（无法证明满足，失败关闭）；
 * arXiv 的 citations 是 null 而不是 0，所以设了 minCitations 会如实剔除。
 * @returns {{items: object[], filters: object, dropped: {year: number, citations: number}, total: number}}
 */
export function filterCandidates(items, options = {}) {
  const filters = normalizeDiscoverFilters(options)
  const dropped = { year: 0, citations: 0 }
  const kept = []
  for (const item of items) {
    if (filters.yearFrom !== null || filters.yearTo !== null) {
      if (!Number.isFinite(item.year)) {
        dropped.year += 1
        continue
      }
      if (filters.yearFrom !== null && item.year < filters.yearFrom) {
        dropped.year += 1
        continue
      }
      if (filters.yearTo !== null && item.year > filters.yearTo) {
        dropped.year += 1
        continue
      }
    }
    if (filters.minCitations !== null) {
      if (!Number.isFinite(item.citations) || item.citations < filters.minCitations) {
        dropped.citations += 1
        continue
      }
    }
    kept.push(item)
  }
  return { items: kept, filters, dropped, total: items.length }
}

/**
 * 多源并发检索。
 * @returns {Promise<{items: object[], sources: object[], filters: object}>}
 */
export async function discover(query, options = {}) {
  const limit = Number(options.limit) > 0 ? Math.trunc(Number(options.limit)) : 8
  const filters = normalizeDiscoverFilters(options)
  const wanted = Array.isArray(options.sources) && options.sources.length > 0
    ? options.sources.filter((name) => CLIENTS[name] !== undefined)
    : SOURCE_NAMES.slice()
  const picked = wanted.length > 0 ? wanted : SOURCE_NAMES.slice()

  const settled = await Promise.allSettled(
    picked.map(async (name) => ({ name, items: await CLIENTS[name](query, limit, filters) })),
  )

  const reports = []
  const groups = []
  settled.forEach((result, index) => {
    const name = picked[index]
    if (result.status === 'fulfilled') {
      reports.push({ name, status: 'ok', count: result.value.items.length })
      groups.push(result.value)
    } else {
      reports.push({
        name,
        status: 'failed',
        count: 0,
        error: String(result.reason?.message ?? result.reason),
      })
    }
  })

  // 排序策略：先按「被几个源同时命中」降序（多源共识 = 更强证据），
  // 再**按源轮转**，避免前 N 条全来自同一个源（三个源结果不重叠时尤其明显）。
  // 过滤放在 merge 之后：一条 arXiv 记录可能与 OpenAlex 合并后补到引用数。
  const merged = mergeItems(groups)
  const applied = filterCandidates(merged, filters)
  const items = applied.items
  items.sort((a, b) => (b.sources?.length ?? 0) - (a.sources?.length ?? 0))

  const buckets = new Map()
  for (const item of items) {
    const primary = item.source
    if (!buckets.has(primary)) buckets.set(primary, [])
    buckets.get(primary).push(item)
  }
  const sourceOrder = reports.filter((r) => r.status === 'ok' && buckets.has(r.name)).map((r) => r.name)
  const interleaved = []
  let round = 0
  let progressed = true
  while (progressed) {
    progressed = false
    for (const name of sourceOrder) {
      const list = buckets.get(name)
      if (round < list.length) {
        interleaved.push(list[round])
        progressed = true
      }
    }
    round += 1
  }

  return {
    items: interleaved.slice(0, limit * 2),
    sources: reports,
    filters: { ...applied.filters, dropped: applied.dropped, total: applied.total },
  }
}
/** 按 DOI 取元数据（Crossref）。 */
export async function resolveDoi(doi) {
  const url = `${ENDPOINTS.crossref}/${encodeURIComponent(doi)}`
  const data = await limitedFetch('crossref-doi:' + url, 'crossref', () => fetchJson(url, { timeoutMs: 12000 }))
  const item = data?.message ?? {}
  return {
    title: plainText(Array.isArray(item.title) ? item.title[0] : item?.title),
    year: yearOf(item?.issued?.['date-parts']?.[0]?.[0]),
    venue: plainText(Array.isArray(item?.['container-title']) ? item['container-title'][0] : ''),
    doi: normalizeDoi(item?.DOI ?? doi),
    arxivId: /^10\.48550\/arxiv\.(.+)$/i.exec(String(item?.DOI ?? ''))?.[1] ?? '',
    url: String(item?.URL ?? ''),
    abstract: plainText(item?.abstract),
    citations: Number(item?.['is-referenced-by-count'] ?? 0) || 0,
    source: 'crossref',
  }
}

/** 按 arXiv id 取元数据（Atom）。 */
export async function resolveArxiv(arxivId) {
  const url = `${ENDPOINTS.arxiv}?id_list=${encodeURIComponent(arxivId)}`
  const xml = await limitedFetch('arxiv-id:' + url, 'arxiv', () => fetchText(url, { timeoutMs: 12000 }))
  const [entry] = parseArxivAtom(xml)
  if (entry === undefined) throw new Error(`arXiv 上没有找到 ${arxivId}`)
  return { ...entry, arxivId, source: 'arxiv' }
}

/** 抓 arXiv 全文（HTML 版），拿不到返回空串。 */
export async function fetchArxivFullText(arxivId) {
  if (!arxivId) return ''
  for (const base of fulltextBases) {
    try {
      const html = await fetchText(`${base}${arxivId}`, { timeoutMs: 15000 })
      const text = htmlToText(html)
      if (text.length >= 2000) return text
    } catch {
      // 换下一个基址；都失败就只用摘要
    }
  }
  return ''
}

/** 简易 HTML → 文本（不引解析库）。 */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|figure|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
