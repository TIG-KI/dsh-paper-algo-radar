/**
 * 词典管理与运行时口径（§7 FR-2.7 / §8 R8.2）。
 *
 * 词典是**数据**（存在快照的 `algorithms` 里），不是配置：
 *  - 种子来自内置 `LEXICON`；用户可以加自定义条目、改别名、合并/拆分、删除
 *  - **口径版本**（`dictVersion`）随词典变更递增；旧提及因此变成「旧口径」，可被 `radar_reextract` 重算
 *
 * 这里的函数都是纯操作（除 `save`），便于测试。
 *
 * @module paper-algo-radar/dict
 */
import { createHash } from 'node:crypto'

import { RadarError } from './errors.js'

import { buildMatchers } from './extract.js'

/** 种子口径版本：词典没被改过时就用它。 */
export const SEED_DICT_VERSION = '2026.10.1'

const matcherCache = new Map()

/** 从一版词典算签名，用于缓存 matchers。 */
function signatureOf(entries) {
  return entries.map((entry) => `${entry.id}:${entry.name}:${(entry.aliases ?? []).join('|')}`).join(';')
}

/** 当前生效的词典条目（快照里为空时回落到内置种子）。 */
export function dictEntries(store, seedLexicon) {
  const entries = [...store.algorithms.values()].filter((entry) => entry.status !== 'disabled')
  return entries.length > 0 ? entries : seedLexicon
}

/** 当前口径版本（`+n` 后缀表示用户改过词典）。 */
export function dictVersionOf(store) {
  const meta = store.meta.get('dict')
  return typeof meta?.version === 'string' && meta.version !== '' ? meta.version : SEED_DICT_VERSION
}

/** 当前口径的匹配器（带缓存，按键值签名失效）。 */
export function matchersFor(store, seedLexicon) {
  const entries = dictEntries(store, seedLexicon)
  const signature = signatureOf(entries)
  const cached = matcherCache.get(signature)
  if (cached !== undefined) return cached
  const built = buildMatchers(entries)
  // 只留最近两版，避免长期运行后缓存膨胀
  if (matcherCache.size > 2) matcherCache.clear()
  matcherCache.set(signature, built)
  return built
}

/** 词典变更后调用：口径版本 +1，并落盘。 */
export async function bumpDict(store) {
  const current = dictVersionOf(store)
  const base = current.includes('+') ? current.split('+')[0] : current
  const times = current.includes('+') ? Number(current.split('+')[1]) || 0 : 0
  const version = `${base}+${times + 1}`
  store.meta.set('dict', { key: 'dict', version, updatedAt: Date.now() })
  await store.save()
  return version
}

function normalizeAliases(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；]/)
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].slice(0, 30)
}

function normalizeType(value) {
  const type = String(value ?? '').toUpperCase()
  return ['DL', 'ML', 'MATH'].includes(type) ? type : 'MATH'
}

/** 新增自定义条目。 */
export async function addDictEntry(store, input) {
  const id = String(input?.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const name = String(input?.name ?? '').trim()
  if (name === '') throw new RadarError('VALIDATION', '缺少算法名', { field: 'name' })
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  // 中文名会被 slug 成空串：用名字的短哈希兜底，保证不同名字不会撞同一个 id
  const suffix = slug !== '' ? slug : createHash('sha1').update(name, 'utf8').digest('hex').slice(0, 8)
  const finalId = id !== '' ? id : `custom-${suffix}`
  if (store.algorithms.has(finalId)) throw new RadarError('CONFLICT', `已存在同名 id：${finalId}`, { field: 'id' })
  // 名字也必须唯一：否则同一算法会有两条词条，同一个词被两个 id 命中
  const nameTaken = [...store.algorithms.values()].find(
    (entry) => entry.status !== 'disabled' && String(entry.name).trim().toLowerCase() === name.toLowerCase(),
  )
  if (nameTaken !== undefined) throw new RadarError('CONFLICT', `已存在同名条目：${nameTaken.name}（id=${nameTaken.id}）`, { field: 'name' })
  const entry = {
    id: finalId,
    name,
    type: normalizeType(input?.type),
    family: String(input?.family ?? '自定义').trim() || '自定义',
    aliases: normalizeAliases(input?.aliases),
    status: 'approved',
    origin: 'custom',
  }
  store.algorithms.set(finalId, entry)
  const version = await bumpDict(store)
  return { entry, version }
}

/** 修改条目（名字 / 类型 / 分类 / 别名整体替换）。 */
export async function updateDictEntry(store, id, patch) {
  const key = String(id ?? '').trim()
  const current = store.algorithms.get(key)
  if (current === undefined) throw new RadarError('NOT_FOUND', `没有这个条目：${key}`, { field: 'id' })
  const next = {
    ...current,
    name: String(patch?.name ?? current.name).trim() || current.name,
    type: patch?.type !== undefined ? normalizeType(patch.type) : current.type,
    family: patch?.family !== undefined ? String(patch.family).trim() : current.family,
    aliases: patch?.aliases !== undefined ? normalizeAliases(patch.aliases) : current.aliases,
    origin: current.origin ?? 'seed',
  }
  store.algorithms.set(key, next)
  const version = await bumpDict(store)
  return { entry: next, version }
}

/** 删除条目（种子条目只标记 disabled，保历史提及可解释）。 */
export async function removeDictEntry(store, id) {
  const key = String(id ?? '').trim()
  const current = store.algorithms.get(key)
  if (current === undefined) throw new RadarError('NOT_FOUND', `没有这个条目：${key}`, { field: 'id' })
  if (current.origin === 'seed') {
    store.algorithms.set(key, { ...current, status: 'disabled' })
  } else {
    store.algorithms.delete(key)
  }
  const version = await bumpDict(store)
  return { removed: key, soft: current.origin === 'seed', version }
}

/**
 * 别名搬移：把一个别名从 `from` 挪到 `to`（合并语义）；
 * `to` 为空表示只从 `from` 删掉（拆分语义）。
 */
export async function moveDictAlias(store, input) {
  const alias = String(input?.alias ?? '').trim()
  if (alias === '') throw new RadarError('VALIDATION', '缺少别名', { field: 'alias' })
  const fromId = String(input?.from ?? '').trim()
  const toId = String(input?.to ?? '').trim()
  const from = store.algorithms.get(fromId)
  if (from === undefined) throw new RadarError('NOT_FOUND', `没有来源条目：${fromId}`, { field: 'from' })
  const aliases = (from.aliases ?? []).filter((item) => String(item).toLowerCase() !== alias.toLowerCase())
  store.algorithms.set(fromId, { ...from, aliases })

  let toEntry = null
  if (toId !== '') {
    const to = store.algorithms.get(toId)
    if (to === undefined) throw new RadarError('NOT_FOUND', `没有目标条目：${toId}`, { field: 'to' })
    const nextAliases = [...new Set([...(to.aliases ?? []), alias])]
    toEntry = { ...to, aliases: nextAliases }
    store.algorithms.set(toId, toEntry)
  }
  const version = await bumpDict(store)
  return { alias, from: fromId, to: toId === '' ? null : toId, version, target: toEntry }
}
