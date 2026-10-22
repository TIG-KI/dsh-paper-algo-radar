/**
 * 导入（§7 FR-7.4）。
 *
 * 三种输入自动识别：
 *  - `export-v2`：本插件导出的全量 JSON（带 `schemaVersion`，`papers` 为数组）
 *  - `v0.2`：v0.2 的 `store.json`（`version:1`，`papers` 为对象）
 *  - `snapshot`：已经是当前快照形态（`version:2` + `paperKeys`）
 *
 * 两种模式：
 *  - `merge`（默认）：按三键合并；已存在的论文**保留本地 id**并补齐空字段
 *  - `overwrite`：整体替换（危险，必须先 dryRun 看预览）
 *
 * 关键设计：**先算计划、再执行**。`planImport()` 只读不写，返回 report + 一个 apply 函数；
 * `dryRun` 时不调用 apply —— 从结构上保证预览不会改到库。
 *
 * 复用：v0.2 → 当前的转换口径全在 `lib/migrate.js`，本模块不重复实现。
 *
 * @module paper-algo-radar/importer
 */
import { migrateSnapshot, SCHEMA_VERSION } from './migrate.js'
import { newPaperId, paperKeysOf, normalizeTitleKey } from './keys.js'
import { RadarError } from './errors.js'

/** 判断输入属于哪种形态。 */
export function detectSnapshotKind(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.schemaVersion === 'number') return 'export-v2'
  if (raw.version === 1) return 'v0.2'
  if (raw.version === SCHEMA_VERSION && raw.paperKeys !== undefined) return 'snapshot'
  if (Array.isArray(raw.papers)) return 'export-v2'
  return null
}

function toMap(value) {
  if (Array.isArray(value)) {
    const out = {}
    for (const item of value) {
      if (item === null || typeof item !== 'object') continue
      const key = item.key !== undefined ? item.key : item.id !== undefined ? item.id : null
      if (key === null) continue
      out[String(key)] = item
    }
    return out
  }
  return value !== null && typeof value === 'object' ? value : {}
}

/** 把任意受支持形态归一成当前快照结构。 */
export function normalizeSnapshot(raw) {
  const kind = detectSnapshotKind(raw)
  if (kind === null) {
    throw new RadarError('VALIDATION', '无法识别的导入文件：既不是本插件的导出，也不是 v0.2 的 store.json。')
  }

  if (kind === 'v0.2') {
    const { data } = migrateSnapshot(raw)
    return { kind, snapshot: data }
  }

  if (kind === 'export-v2') {
    // 导出的 papers/mentions 是数组；补上 paperKeys 后再过一遍迁移，保证缺字段被补齐
    const papers = toMap(raw.papers)
    const mentionsArray = Array.isArray(raw.mentions) ? raw.mentions : toMap(raw.mentions)
    const mentions = Array.isArray(mentionsArray)
      ? Object.fromEntries(
          mentionsArray
            .filter((m) => m && m.paperId && m.algorithmId)
            .map((m) => [`${m.paperId}::${m.algorithmId}`, m])
        )
      : mentionsArray

    const provisional = {
      version: 1, // 走一遍迁移，把 v2 导出里可能缺的字段补齐
      savedAt: raw.exportedAt,
      papers,
      algorithms: toMap(raw.algorithms),
      mentions,
      meta: { state: { schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION } },
    }
    const { data } = migrateSnapshot(provisional)
    return { kind, snapshot: data }
  }

  // 已经是当前快照
  const { data } = migrateSnapshot(raw)
  return { kind, snapshot: data }
}

/**
 * 算导入计划。**只读 store，不改它。**
 *
 * @returns {{ report: object, apply: (store: object) => void }}
 */
export function planImport(store, raw, options = {}) {
  const mode = options.mode === 'overwrite' ? 'overwrite' : 'merge'
  const dryRun = options.dryRun !== false
  const { kind, snapshot } = normalizeSnapshot(raw)

  const incomingPapers = Object.entries(snapshot.papers)
  const report = {
    kind,
    mode,
    dryRun,
    incomingPapers: incomingPapers.length,
    incomingMentions: Object.keys(snapshot.mentions).length,
    added: 0,
    updated: 0,
    replaced: 0,
    skippedSame: 0,
    conflicts: [],
  }

  const idMap = new Map()

  if (mode === 'overwrite') {
    report.replaced = store.papers.size
    for (const [incomingId, paper] of incomingPapers) {
      idMap.set(incomingId, store.papers.has(incomingId) ? incomingId : incomingId)
      report.added += 1
    }
  } else {
    for (const [incomingId, paper] of incomingPapers) {
      let localId = null
      for (const key of paperKeysOf(paper)) {
        const owner = store.paperKeys.get(key)
        if (owner !== undefined && store.papers.has(owner)) {
          localId = owner
          break
        }
      }
      if (localId === null) {
        // 新论文：id 已被占用就换一个，避免覆盖无关记录
        localId = store.papers.has(incomingId) ? newPaperId() : incomingId
        report.added += 1
      } else {
        report.updated += 1
        if (localId !== incomingId) {
          report.conflicts.push({ incomingId, localId })
        }
      }
      idMap.set(incomingId, localId)
    }
  }

  const apply = (target) => {
    if (mode === 'overwrite') {
      target.papers.clear()
      target.mentions.clear()
      target.paperKeys.clear()
    }

    for (const [incomingId, paper] of incomingPapers) {
      const localId = idMap.get(incomingId) ?? incomingId
      const previous = target.papers.get(localId)
      const merged = {
        ...(previous ?? {}),
        ...paper,
        id: localId,
        // 本地已有的非空字段不被打回空值
        title: paper.title || previous?.title || '未命名论文',
        year: paper.year ?? previous?.year ?? null,
        venue: paper.venue || previous?.venue || '',
        doi: paper.doi || previous?.doi || '',
        arxivId: paper.arxivId || previous?.arxivId || '',
        fields: paper.fields && paper.fields.length > 0 ? paper.fields : previous?.fields ?? ['未分类'],
        // 导入不带来正文文件，hasText 一律以「本地文件是否存在」为准，这里保守置 false
        hasText: previous?.hasText === true,
        rawChars: previous?.rawChars ?? 0,
        textHash: previous?.textHash ?? '',
      }
      merged.dedupeKey = paperKeysOf(merged)[0] ?? ''
      target.papers.set(localId, merged)
    }

    // 词典：缺的补上，已有的不覆盖（本地可能改过别名）
    for (const [id, entry] of Object.entries(snapshot.algorithms ?? {})) {
      if (!target.algorithms.has(id)) target.algorithms.set(id, entry)
    }

    // 提及：按 idMap 重映射，整体替换该论文的提及
    for (const mention of Object.values(snapshot.mentions ?? {})) {
      const localId = idMap.get(mention.paperId)
      if (localId === undefined) continue
      target.mentions.set(`${localId}::${mention.algorithmId}`, {
        ...mention,
        paperId: localId,
      })
    }

    // 三键重建（以论文为准）
    target.paperKeys.clear()
    for (const paper of target.papers.values()) {
      for (const key of paperKeysOf(paper)) {
        if (!target.paperKeys.has(key)) target.paperKeys.set(key, paper.id)
      }
    }
    target.meta.set('state', {
      ...(target.meta.get('state') ?? {}),
      schemaVersion: SCHEMA_VERSION,
      lastImportAt: Date.now(),
    })
  }

  return { report, apply }
}
