/**
 * W1.1 验收：出站限速与缓存（§13.2 / FR-6.10）。
 *
 * 全程本地假服务器，不碰真网络。
 * 运行：node test/throttle.test.mjs
 */
import { createServer } from 'node:http'

import { setAllowedHosts, setFetch } from '../lib/net.js'
import {
  cacheStats,
  clearSourceCache,
  configureThrottle,
  discover,
  resetEndpoints,
  setEndpoints,
} from '../lib/sources.js'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const hits = { openalex: 0, crossref: 0, arxiv: 0 }
const timestamps = { openalex: [], crossref: [], arxiv: [] }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const name = url.pathname.slice(1)
  if (hits[name] !== undefined) {
    hits[name] += 1
    timestamps[name].push(Date.now())
  }
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/openalex') {
    return json({
      results: [
        {
          id: 'W1',
          doi: 'https://doi.org/10.1/x',
          title: '缓存测试论文',
          publication_year: 2024,
          primary_location: { source: { display_name: 'V' } },
          cited_by_count: 1,
        },
      ],
    })
  }
  if (url.pathname === '/crossref') {
    return json({ message: { items: [] } })
  }
  if (url.pathname === '/arxiv') {
    res.writeHead(200, { 'content-type': 'application/atom+xml' })
    return res.end('<feed></feed>')
  }
  return json({})
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
setAllowedHosts(['127.0.0.1'])
setFetch(globalThis.fetch)
setEndpoints({ openalex: `${base}/openalex`, crossref: `${base}/crossref`, arxiv: `${base}/arxiv` })

try {
  console.log('\n[1] 缓存：同查询不重复出站')
  clearSourceCache()
  configureThrottle({ intervalMs: 0, ttlMs: 60000 })
  hits.openalex = 0
  const first = await discover('同一查询', { limit: 3, sources: ['openalex'] })
  check('第一次出站 1 次', hits.openalex === 1, String(hits.openalex))
  check('拿到结果', first.items.length === 1, String(first.items.length))
  const second = await discover('同一查询', { limit: 3, sources: ['openalex'] })
  check('第二次命中缓存（没再出站）', hits.openalex === 1, String(hits.openalex))
  check('缓存结果一致', second.items[0]?.title === first.items[0]?.title)
  const third = await discover('另一个查询', { limit: 3, sources: ['openalex'] })
  check('不同查询会出站', hits.openalex === 2, String(hits.openalex))
  check('有统计信息', cacheStats().size >= 2, JSON.stringify(cacheStats()))

  console.log('\n[2] 缓存过期后重新出站')
  configureThrottle({ intervalMs: 0, ttlMs: 1 })
  clearSourceCache()
  hits.openalex = 0
  await discover('过期测试', { limit: 3, sources: ['openalex'] })
  await new Promise((r) => setTimeout(r, 10))
  await discover('过期测试', { limit: 3, sources: ['openalex'] })
  check('TTL 极小时两次都出站', hits.openalex === 2, String(hits.openalex))

  console.log('\n[3] 限速：同主机请求有最小间隔')
  configureThrottle({ intervalMs: 120, ttlMs: 0 })
  clearSourceCache()
  hits.openalex = 0
  timestamps.openalex = []
  await discover('限速A', { limit: 2, sources: ['openalex'] })
  await discover('限速B', { limit: 2, sources: ['openalex'] })
  await discover('限速C', { limit: 2, sources: ['openalex'] })
  check('三次都出站', hits.openalex === 3, String(hits.openalex))
  const gaps = timestamps.openalex.slice(1).map((t, i) => t - timestamps.openalex[i])
  check('相邻请求间隔 ≥ 100ms', gaps.every((g) => g >= 100), JSON.stringify(gaps))

  console.log('\n[4] 不同主机互不影响')
  configureThrottle({ intervalMs: 120, ttlMs: 0 })
  clearSourceCache()
  timestamps.openalex = []
  timestamps.crossref = []
  hits.openalex = 0
  hits.crossref = 0
  await discover('并发主机', { limit: 2, sources: ['openalex', 'crossref'] })
  check('两个主机都出站', hits.openalex === 1 && hits.crossref === 1, `${hits.openalex}/${hits.crossref}`)
  if (timestamps.openalex.length > 0 && timestamps.crossref.length > 0) {
    const delta = Math.abs(timestamps.openalex[0] - timestamps.crossref[0])
    check('不同主机可以并发（间隔 < 限速值）', delta < 120, String(delta))
  }

  console.log('\n[5] 缓存上限')
  configureThrottle({ intervalMs: 0, ttlMs: 60000 })
  clearSourceCache()
  for (let i = 0; i < 210; i += 1) {
    await discover(`查询${i}`, { limit: 1, sources: ['openalex'] })
  }
  check('缓存不会无限增长（≤200）', cacheStats().size <= 200, String(cacheStats().size))
} finally {
  await new Promise((resolve) => server.close(resolve))
  resetEndpoints()
  configureThrottle({ intervalMs: 300, ttlMs: 5 * 60_000 })
  clearSourceCache()
  setAllowedHosts(['api.openalex.org', 'api.crossref.org', 'export.arxiv.org', 'arxiv.org', 'ar5iv.labs.arxiv.org', 'doi.org'])
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
