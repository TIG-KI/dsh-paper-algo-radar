/**
 * 多源轮转排序的验收（不需要网络）：三个源给互不重叠的结果，前 N 条应覆盖多个源。
 * 运行：node test/interleave.test.mjs
 */
import { setAllowedHosts, setFetch } from '../lib/net.js'
import { discover, resetEndpoints, setEndpoints } from '../lib/sources.js'
import { createServer } from 'node:http'

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

const mk = (source, count) => ({
  results: Array.from({ length: count }, (_, i) => ({
    id: `${source}-${i}`,
    doi: `${source}/10.1/${i}`,
    title: `${source} 论文 ${i}`,
    publication_year: 2020 + i,
    primary_location: { source: { display_name: 'V' } },
    cited_by_count: i,
  })),
})

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/openalex') return json(mk('openalex', 3))
  if (url.pathname === '/crossref') {
    const items = mk('crossref', 3).results.map((w) => ({
      DOI: w.doi,
      title: [w.title],
      issued: { 'date-parts': [[w.publication_year]] },
      'container-title': ['V'],
    }))
    return json({ message: { items } })
  }
  if (url.pathname === '/arxiv') {
    const entries = Array.from({ length: 3 }, (_, i) => `
      <entry>
        <id>http://arxiv.org/abs/2401.0000${i}</id>
        <title>arxiv 论文 ${i}</title>
        <summary>摘要 ${i}</summary>
        <published>2021-01-01T00:00:00Z</published>
      </entry>`).join('')
    res.writeHead(200, { 'content-type': 'application/atom+xml' })
    return res.end(`<feed>${entries}</feed>`)
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
  const result = await discover('x', { limit: 6 })
  const names = result.items.map((item) => item.source)
  console.log(`  前 6 条来源顺序：${names.join(' → ')}`)
  check('结果来自多个源（不是单一源霸榜）', new Set(names).size === 3, [...new Set(names)].join(','))
  check('三个源都出现在前 3 条', new Set(names.slice(0, 3)).size === 3, names.slice(0, 3).join(','))
  check('轮转顺序稳定（openalex 先）', names[0] === 'openalex' && names[1] === 'crossref' && names[2] === 'arxiv', names.join(','))
  check('总数 = 3 源 × 3 条 = 9（上限 limit×2=12 未触发）', result.items.length === 9, String(result.items.length))
  check('上限生效：limit=2 时最多 4 条', (await discover('x', { limit: 2 })).items.length <= 4)
} finally {
  await new Promise((resolve) => server.close(resolve))
  resetEndpoints()
  setAllowedHosts(['api.openalex.org', 'api.crossref.org', 'export.arxiv.org', 'arxiv.org', 'ar5iv.labs.arxiv.org', 'doi.org'])
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
