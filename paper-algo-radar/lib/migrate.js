/**
 * 快照迁移：v0.2（version:1）→ 当前（version:2）。
 *
 * 纯函数：输入解析后的 JSON，输出新对象与报告，**不改输入、不碰磁盘**。
 * 由 `Store.load()` 调用；迁移结果在下次写入时落盘（加载期不写盘，FR-10.5）。
 *
 * 迁移口径（§10.1 迁移器，与网站版逐年对齐）：
 *  1. 原 id 匹配 `^p_[0-9a-f]{16}$` 则沿用，否则换新并同步改引用；
 *  2. 重建三键（DOI / arXiv / 规范化标题）；
 *  3. 标题规范化 = NFKC → trim → 折叠空白 → 小写；
 *  4. `depth` 缺失时按 `chars ≥ 300 ? fulltext : abstract`；
 *  5. 提及补 `dictVersion='v0.2-legacy'`、`role=null`、`sections` 键名归一；
 *  6. 无正文 → `hasText=false`；
 *  7. 同一文件重复迁移不产生重复论文（幂等）。
 *
 * @module paper-algo-radar/migrate
 */
import { isValidPaperId, newPaperId, paperKeysOf, normalizeDoi, normalizeArxivId } from './keys.js'

export const SCHEMA_VERSION = 2
export const LEGACY_DICT_VERSION = 'v0.2-legacy'

/** §8 R5 的八个章节键，顺序固定。 */
export const SECTION_KEYS = [
  'abstract',
  'intro',
  'related',
  'method',
  'experiment',
  'discussion',
  'conclusion',
  'other',
]

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** 章节对象：键名归一 + 补齐 8 个键 + 数值化。 */
function normalizeSections(raw) {
  const out = {}
  for (const key of SECTION_KEYS) out[key] = 0
  let renamed = 0
  for (const [key, value] of Object.entries(asObject(raw))) {
    const target = key === 'experiments' ? 'experiment' : key
    if (target !== key) renamed += 1
    out[target] = (out[target] ?? 0) + asNumber(value, 0)
  }
  return { sections: out, renamed }
}

/**
 * @param {object} raw 解析后的快照
 * @param {{ now?: number }} [options] `now` 仅用于补缺失的时间戳，便于测试确定性
 * @returns {{ data: object, report: object }}
 */
export function migrateSnapshot(raw, options = {}) {
  const now = asNumber(options.now, Date.now())
  const source = asObject(raw)
  const fromVersion = asNumber(source.version, 0)

  const report = {
    fromVersion,
    toVersion: SCHEMA_VERSION,
    changed: false,
    papers: 0,
    mentions: 0,
    remappedIds: [],
    keysBuilt: 0,
    keyConflicts: [],
    sectionsRenamed: 0,
    dictVersionBackfilled: 0,
    rolesFilled: 0,
    depthInferred: 0,
    droppedMentions: 0,
    duplicatesMerged: 0,
  }

  // ── 论文 ───────────────────────────────────────────────
  const idRemap = new Map()
  const papers = {}
  for (const [rawId, value] of Object.entries(asObject(source.papers))) {
    const paper = asObject(value)
    const id = isValidPaperId(paper.id) ? paper.id : isValidPaperId(rawId) ? rawId : newPaperId()
    if (id !== rawId) {
      idRemap.set(rawId, id)
      report.remappedIds.push({ from: rawId, to: id })
    }
    if (id !== paper.id) report.changed = true

    const chars = asNumber(paper.chars, 0)
    let depth = paper.depth === 'abstract' || paper.depth === 'fulltext' ? paper.depth : null
    if (depth === null) {
      // §10.1 ④：`chars ≥ 300 ? fulltext : abstract`
      depth = chars >= 300 ? 'fulltext' : 'abstract'
      report.depthInferred += 1
      report.changed = true
    }

    const fields = Array.isArray(paper.fields)
      ? paper.fields.filter((f) => typeof f === 'string' && f.trim() !== '').slice(0, 8)
      : []
    const normalizedFields = fields.length > 0 ? fields : ['未分类']
    if (!Array.isArray(paper.fields) || paper.fields.length === 0) report.changed = true

    const record = {
      id,
      dedupeKey: '',
      title: asString(paper.title, '未命名论文').slice(0, 300),
      year: typeof paper.year === 'number' ? paper.year : null,
      venue: asString(paper.venue).slice(0, 120),
      // 规范化：小写 + 去 https://doi.org/ 前缀（§9.1）
      doi: normalizeDoi(paper.doi),
      arxivId: normalizeArxivId(paper.arxivId),
      fields: normalizedFields,
      depth,
      chars,
      hitCount: asNumber(paper.hitCount, 0),
      hasText: paper.hasText === true,
      rawChars: asNumber(paper.rawChars, 0),
      textHash: asString(paper.textHash),
      isSample: paper.isSample === true,
      status: paper.status ?? null,
      readAt: asNumber(paper.readAt, now),
      updatedAt: asNumber(paper.updatedAt, now),
    }
    const keys = paperKeysOf(record)
    record.dedupeKey = keys.length > 0 ? keys[0] : ''

    if (record.hasText !== paper.hasText || record.rawChars !== paper.rawChars || record.textHash !== paper.textHash) {
      report.changed = true
    }
    if (paper.dedupeKey !== record.dedupeKey) report.changed = true

    if (papers[id] !== undefined) {
      report.duplicatesMerged += 1
      report.changed = true
      continue
    }
    papers[id] = record
    report.papers += 1
  }

  // ── 提及 ───────────────────────────────────────────────
  const mentions = {}
  for (const value of Object.values(asObject(source.mentions))) {
    const mention = asObject(value)
    const rawPaperId = asString(mention.paperId)
    const paperId = idRemap.get(rawPaperId) ?? rawPaperId
    if (papers[paperId] === undefined) {
      report.droppedMentions += 1
      report.changed = true
      continue
    }
    const algorithmId = asString(mention.algorithmId)
    if (algorithmId === '') {
      report.droppedMentions += 1
      report.changed = true
      continue
    }

    const { sections, renamed } = normalizeSections(mention.sections)
    report.sectionsRenamed += renamed
    if (renamed > 0) report.changed = true

    let dictVersion = asString(mention.dictVersion)
    if (dictVersion === '') {
      dictVersion = LEGACY_DICT_VERSION
      report.dictVersionBackfilled += 1
      report.changed = true
    }

    let role = mention.role
    if (role === undefined) {
      role = null
      report.rolesFilled += 1
      report.changed = true
    }

    const key = `${paperId}::${algorithmId}`
    if (mentions[key] !== undefined) {
      report.duplicatesMerged += 1
      report.changed = true
    }
    mentions[key] = {
      paperId,
      algorithmId,
      count: asNumber(mention.count, 1),
      sections,
      snippets: Array.isArray(mention.snippets) ? mention.snippets.filter((s) => typeof s === 'string').slice(0, 3) : [],
      role,
      dictVersion,
      updatedAt: asNumber(mention.updatedAt, now),
    }
    report.mentions += 1
  }

  // ── 三键倒排（以论文为准重建，不用文件里那份） ────────────
  const paperKeys = {}
  for (const paper of Object.values(papers)) {
    for (const key of paperKeysOf(paper)) {
      const owner = paperKeys[key]
      if (owner === undefined) {
        paperKeys[key] = paper.id
        report.keysBuilt += 1
      } else if (owner !== paper.id) {
        report.keyConflicts.push({ key, kept: owner, dropped: paper.id })
        report.changed = true
      }
    }
  }

  // ── meta ───────────────────────────────────────────────
  const meta = { ...asObject(source.meta) }
  const state = { ...asObject(meta.state), schemaVersion: SCHEMA_VERSION }
  meta.state = state
  if (fromVersion !== SCHEMA_VERSION) report.changed = true

  const data = {
    version: SCHEMA_VERSION,
    savedAt: asString(source.savedAt),
    papers,
    algorithms: asObject(source.algorithms),
    mentions,
    paperKeys,
    meta,
  }

  return { data, report }
}
