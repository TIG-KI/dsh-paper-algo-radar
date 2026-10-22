/**
 * 工具契约的公共件（§10.1 / FR-8.2 / FR-8.4 / §8 R12）。
 *
 * 三件事：
 *  1. 读 / 写工具名清单——供宿主策略与测试引用，避免字符串散落；
 *  2. 分页与码位序排序——`limit/offset/total/truncated` 全套统一；
 *  3. 返回体预算——单次工具返回 ≤ 12,000 字符，超限**显式截断并标注**，不静默丢。
 *
 * @module paper-algo-radar/contract
 */

/** 只读工具：不改变库内容。 */
export const READ_TOOL_NAMES = [
  'radar_ranking',
  'radar_papers',
  'radar_status',
  'radar_discover',
  'radar_export',
  'radar_algorithm',
  'radar_trends',
  'radar_fields',
  'radar_cooccurrence',
  'radar_matrix',
]

/** 写工具：会落盘，受 `writeEnabled` 与审批约束（W1.0 起）。 */
export const WRITE_TOOL_NAMES = [
  'radar_add',
  'radar_add_batch',
  'radar_reextract',
  'radar_import',
  'radar_remove',
  'radar_clear',
  'radar_restore',
  'radar_samples',
  'radar_dictionary',
  'radar_candidates',
]

/** 单次工具返回的字符预算（§8 R12.2）。 */
export const MAX_RESULT_CHARS = 12000

export const LIMIT_DEFAULT = 20
export const LIMIT_MAX = 50

/**
 * 码位比较（§8 G-5：禁用 `localeCompare`）。
 * 逐 code point 比，中文与英文混排时结果与机器 locale 无关。
 */
export function compareCodePoints(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x === y) return 0
  const xs = [...x]
  const ys = [...y]
  const n = Math.min(xs.length, ys.length)
  for (let i = 0; i < n; i += 1) {
    const cx = xs[i].codePointAt(0)
    const cy = ys[i].codePointAt(0)
    if (cx !== cy) return cx < cy ? -1 : 1
  }
  return xs.length - ys.length
}

/** 把任意输入夹到 [min, max] 的整数；非法输入回落到 fallback。 */
export function clampInt(value, min, max, fallback = min) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/**
 * 分页：返回 `{ items, total, offset, limit, truncated }`。
 * `truncated` 表示「后面还有」，不是「被截断丢弃」——两者语义不同。
 */
export function paginate(list, options = {}) {
  const total = Array.isArray(list) ? list.length : 0
  const limit = clampInt(options.limit, 1, LIMIT_MAX, LIMIT_DEFAULT)
  const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0)
  const start = Math.min(offset, total)
  const items = (Array.isArray(list) ? list : []).slice(start, start + limit)
  return {
    items,
    total,
    offset: start,
    limit,
    truncated: start + items.length < total,
  }
}

/**
 * 返回体预算（§8 R12.2）。
 *
 * 做法：序列化超限时，把体积最大的数组字段逐个从尾部收窄，直到进入预算；
 * 每个被收窄的字段都记进 `truncatedFields`，并保留原 `total`。
 * **绝不静默丢弃**——模型必须能从返回值看出「还有多少没看到」。
 */
export function boundResult(value, maxChars = MAX_RESULT_CHARS) {
  if (value === null || typeof value !== 'object') return value
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return value
  }
  if (text.length <= maxChars) return value

  const out = { ...value }
  const truncatedFields = []

  // 数组字段按体积从大到小收窄
  const arrays = Object.entries(out)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)

  for (const [field, arr] of arrays) {
    if (JSON.stringify(out).length <= maxChars) break
    const total = arr.length
    let keep = total
    while (keep > 0) {
      keep = Math.max(0, keep - Math.max(1, Math.floor(keep / 4)))
      out[field] = arr.slice(0, keep)
      if (JSON.stringify(out).length <= maxChars) break
    }
    if (keep < total) {
      truncatedFields.push({ field, shown: out[field].length, total })
    }
  }

  out.truncated = true
  if (truncatedFields.length > 0) out.truncatedFields = truncatedFields
  return out
}
