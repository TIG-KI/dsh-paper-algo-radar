/**
 * 撤销窗口（§7 FR-2.10 / FR-2.11）。
 *
 * 设计：
 *  - 只记**最近若干次**可撤销操作（默认 10 条），每条带过期时间。
 *  - **懒过期**：不起定时器（P-6 不允许加载期副作用），在 `take()` / `prune()` 时按 `now` 判定；
 *    过期条目的正文文件在 prune 时真正删除。
 *  - 正文文件在窗口内**不删**，撤销才能把「能不能重算」一起恢复。
 *
 * @module paper-algo-radar/undo
 */

const DEFAULT_WINDOW_MS = 10_000
const DEFAULT_MAX_ENTRIES = 10

let seq = 0

export class UndoStack {
  /**
   * @param {{ windowMs?: number, maxEntries?: number, now?: () => number, onExpire?: (entry: object) => void }} [options]
   */
  constructor(options = {}) {
    this.windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_WINDOW_MS
    this.maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onExpire = typeof options.onExpire === 'function' ? options.onExpire : null
    this.entries = []
  }

  /** 记一次可撤销操作，返回令牌与过期时间。 */
  push(kind, payload) {
    this.prune()
    seq += 1
    const entry = {
      token: `u_${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      kind,
      payload,
      createdAt: this.now(),
      expiresAt: this.now() + this.windowMs,
    }
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) {
      const dropped = this.entries.shift()
      this.expire(dropped)
    }
    return { token: entry.token, kind: entry.kind, expiresAt: entry.expiresAt }
  }

  /** 取一个**未过期**的条目（取走即删除）；过期的返回 null。 */
  take(token) {
    this.prune()
    const index = this.entries.findIndex((entry) => entry.token === token)
    if (index < 0) return null
    const [entry] = this.entries.splice(index, 1)
    return entry
  }

  /** 不看内容地丢弃（例如用户主动放弃撤销）。 */
  drop(token) {
    const index = this.entries.findIndex((entry) => entry.token === token)
    if (index < 0) return false
    const [entry] = this.entries.splice(index, 1)
    this.expire(entry)
    return true
  }

  /** 清掉所有已过期条目，回调让调用方删除正文文件。 */
  prune() {
    const now = this.now()
    const expired = this.entries.filter((entry) => entry.expiresAt <= now)
    if (expired.length === 0) return 0
    this.entries = this.entries.filter((entry) => entry.expiresAt > now)
    for (const entry of expired) this.expire(entry)
    return expired.length
  }

  expire(entry) {
    if (this.onExpire === null) return
    try {
      this.onExpire(entry)
    } catch {
      // 过期清理失败不该影响调用方
    }
  }

  /** 当前可撤销的操作（给面板显示「撤销」按钮用）。 */
  list() {
    this.prune()
    return this.entries.map((entry) => ({
      token: entry.token,
      kind: entry.kind,
      expiresAt: entry.expiresAt,
      label: entry.payload?.label ?? entry.kind,
    }))
  }

  size() {
    return this.entries.length
  }
}
