/**
 * 新词候选队列（§7 FR-2.8）。
 *
 * 定位：插件**不调用 LLM**；它给模型一个「把词典外看到的算法名放这里」的队列。
 * 用户（或在面板里）复核后可以一键转成正式词典条目。
 *
 * 存储：`store.meta` 的 `candidates` 键，形态 `{ key, version, items: [...] }`。
 * 候选去重按规范化名字；状态 pending / approved / rejected。
 *
 * @module paper-algo-radar/candidates
 */
import { RadarError } from './errors.js'

const META_KEY = 'candidates'
const MAX_ITEMS = 200

function keyOf(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 读候选列表（永远返回数组）。 */
export function listCandidates(store, options = {}) {
  const record = store.meta.get(META_KEY)
  const items = Array.isArray(record?.items) ? record.items : []
  const status = options.status === undefined ? null : String(options.status)
  const filtered = status === null ? items : items.filter((item) => item.status === status)
  return filtered.slice(0, Number(options.limit) > 0 ? Number(options.limit) : MAX_ITEMS)
}

async function saveCandidates(store, items) {
  store.meta.set(META_KEY, { key: META_KEY, version: 1, updatedAt: Date.now(), items: items.slice(0, MAX_ITEMS) })
  await store.save()
}

/**
 * 收下一条候选。
 * @returns {Promise<{created: boolean, item: object, pending: number}>}
 */
export async function addCandidate(store, input) {
  const name = String(input?.name ?? '').trim()
  if (name === '') throw new RadarError('VALIDATION', '缺少候选名', { field: 'name' })
  const record = store.meta.get(META_KEY)
  const items = Array.isArray(record?.items) ? [...record.items] : []
  const existing = items.find((item) => keyOf(item.name) === keyOf(name))
  if (existing !== undefined) {
    // 重复提交：累加出现次数并保留最早的上下文
    existing.seen = (existing.seen ?? 1) + 1
    existing.lastAt = Date.now()
    if (input?.paperId !== undefined && existing.paperId === undefined) existing.paperId = String(input.paperId)
    await saveCandidates(store, items)
    return { created: false, item: existing, pending: items.filter((i) => i.status === 'pending').length }
  }
  const item = {
    id: `c_${keyOf(name).replace(/[^a-z0-9]+/g, '-').slice(0, 24) || Date.now().toString(36)}`,
    name,
    aliases: Array.isArray(input?.aliases) ? input.aliases.map(String).slice(0, 10) : [],
    note: String(input?.note ?? '').slice(0, 200),
    paperId: input?.paperId !== undefined ? String(input.paperId) : null,
    status: 'pending',
    seen: 1,
    createdAt: Date.now(),
    lastAt: Date.now(),
  }
  items.unshift(item)
  await saveCandidates(store, items)
  return { created: true, item, pending: items.filter((i) => i.status === 'pending').length }
}

function findIndex(items, idOrName) {
  const needle = String(idOrName ?? '').trim()
  if (needle === '') return -1
  return items.findIndex((item) => item.id === needle || keyOf(item.name) === keyOf(needle))
}

/** 标记为拒绝；不删记录（避免又被当成新词提上来）。 */
export async function rejectCandidate(store, idOrName) {
  const record = store.meta.get(META_KEY)
  const items = Array.isArray(record?.items) ? [...record.items] : []
  const index = findIndex(items, idOrName)
  if (index < 0) throw new RadarError('NOT_FOUND', `没有这个候选：${idOrName}`, { field: 'id' })
  items[index] = { ...items[index], status: 'rejected', decidedAt: Date.now() }
  await saveCandidates(store, items)
  return { item: items[index], pending: items.filter((i) => i.status === 'pending').length }
}

/** 标记为已采纳（词典条目由调用方通过 addDictEntry 创建）。 */
export async function markCandidateApproved(store, idOrName, dictEntryId) {
  const record = store.meta.get(META_KEY)
  const items = Array.isArray(record?.items) ? [...record.items] : []
  const index = findIndex(items, idOrName)
  if (index < 0) throw new RadarError('NOT_FOUND', `没有这个候选：${idOrName}`, { field: 'id' })
  items[index] = { ...items[index], status: 'approved', decidedAt: Date.now(), dictEntryId }
  await saveCandidates(store, items)
  return { item: items[index], pending: items.filter((i) => i.status === 'pending').length }
}

/** 候选统计（给面板与状态用）。 */
export function candidateStats(store) {
  const record = store.meta.get(META_KEY)
  const items = Array.isArray(record?.items) ? record.items : []
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    approved: items.filter((item) => item.status === 'approved').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
  }
}
