/**
 * 出站 HTTP 的最小封装（§8 R10 出站白名单的落点）。
 *
 * 设计约束：
 *  - **零依赖**：只用全局 `fetch`。
 *  - **可注入**：`setFetch()` 让测试用本地假服务器/假响应，不碰真网络。
 *  - **必带超时**：任何一次出站都有上限，绝不无限挂住（用 AbortController，不用全局定时器）。
 *  - 只允许白名单主机；白名单本身也可注入（测试用 127.0.0.1）。
 *
 * @module paper-algo-radar/net
 */

const DEFAULT_ALLOWED_HOSTS = [
  'api.openalex.org',
  'api.crossref.org',
  'export.arxiv.org',
  'arxiv.org',
  'ar5iv.labs.arxiv.org',
  'doi.org',
]

let allowedHosts = new Set(DEFAULT_ALLOWED_HOSTS)
let fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null

/** 测试/高级用法：替换 fetch 实现。传 null 恢复全局 fetch。 */
export function setFetch(impl) {
  fetchImpl = impl === null ? globalThis.fetch.bind(globalThis) : impl
}

/** 测试/高级用法：替换允许的主机集合。 */
export function setAllowedHosts(hosts) {
  allowedHosts = new Set(hosts)
}

export function allowedHostList() {
  return [...allowedHosts]
}

const USER_AGENT = 'paper-algo-radar/0.2 (local research tool)'

/**
 * 带超时与白名单的抓取。
 * @returns {Promise<Response>}
 * @throws {Error} 主机不在白名单、超时、网络失败
 */
export async function fetchRaw(url, options = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`不是合法的 URL：${url}`)
  }
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`出站被拒：${parsed.hostname} 不在白名单内`)
  }
  if (fetchImpl === null) throw new Error('当前环境没有 fetch')

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: { 'user-agent': USER_AGENT, ...(options.headers ?? {}) },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 抓 JSON；非 2xx 抛错（带状态码）。 */
export async function fetchJson(url, options = {}) {
  const response = await fetchRaw(url, options)
  if (!response.ok) throw new Error(`HTTP ${response.status}（${new URL(url).hostname}）`)
  return response.json()
}

/** 抓文本；非 2xx 抛错。 */
export async function fetchText(url, options = {}) {
  const response = await fetchRaw(url, options)
  if (!response.ok) throw new Error(`HTTP ${response.status}（${new URL(url).hostname}）`)
  return response.text()
}
