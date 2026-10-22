/**
 * W1.0 验收：自带多源检索（FR-6.2 / P-7）与快速添加的输入解析（FR-1.7）。
 *
 * 全程用**本地假服务器**，不碰真网络：
 *  - OpenAlex / Crossref 返回 JSON，arXiv 返回 Atom
 *  - Crossref 正常，arXiv 故意 500 → 验证「单源失败不影响其它源」
 *
 * 运行：node test/sources.test.mjs
 */
import { createServer } from 'node:http'

import { setAllowedHosts, setFetch } from '../lib/net.js'
import {
  discover,
  mergeItems,
  normalizeDiscoverFilters,
  filterCandidates,
  parseArxivAtom,
  resetEndpoints,
  resolveArxiv,
  resolveDoi,
  setEndpoints,
  abstractFromInvertedIndex,
} from '../lib/sources.js'
import { parseInputTarget } from '../lib/index.js'

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

const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>LSTM 与 CRF 在命名实体识别中的组合</title>
    <summary>本文比较 LSTM、CRF 与 Transformer 在命名实体识别上的效果。</summary>
    <published>2024-01-22T00:00:00Z</published>
  </entry>
</feed>`

const OPENALEX_BODY = {
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/ABC',
      title: '空气质量预测中的深度学习方法',
      publication_year: 2022,
      primary_location: { source: { display_name: '环境科学学报' } },
      cited_by_count: 12,
      abstract_inverted_index: { 空气: [0], 质量: [1], 预测: [2] },
    },
  ],
}

const CROSSREF_LIST_BODY = {
  message: {
    items: [
      {
        DOI: '10.1000/abc',
        title: ['空气质量预测中的深度学习方法'],
        issued: { 'date-parts': [[2022]] },
        'container-title': ['环境科学学报'],
        'is-referenced-by-count': 30,
        abstract: '<jats:p>同一篇论文（DOI 相同），用来验证去重。</jats:p>',
        URL: 'https://doi.org/10.1000/abc',
      },
      {
        DOI: '10.1000/xyz',
        title: ['另一篇：SVM 与随机森林对比'],
        issued: { 'date-parts': [[2021]] },
        'container-title': ['机器学习学报'],
        'is-referenced-by-count': 5,
        abstract: '<jats:p>摘要</jats:p>',
        URL: 'https://doi.org/10.1000/xyz',
      },
    ],
  },
}

const CROSSREF_DOI_BODY = {
  message: {
    DOI: '10.1000/abc',
    title: ['空气质量预测中的深度学习方法'],
    issued: { 'date-parts': [[2022]] },
    'container-title': ['环境科学学报'],
    'is-referenced-by-count': 30,
    abstract: '<jats:p>这是摘要。</jats:p>',
    URL: 'https://doi.org/10.1000/abc',
  },
}

const hitCount = { openalex: 0, crossref: 0, arxiv: 0 }
const hitUrls = []

const server = createServer((req, res) => {
  hitUrls.push(req.url)
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  if (url.pathname === '/openalex') {
    hitCount.openalex += 1
    return send(200, OPENALEX_BODY)
  }
  if (url.pathname === '/crossref') {
    hitCount.crossref += 1
    if (url.searchParams.get('query') !== null) return send(200, CROSSREF_LIST_BODY)
    return send(200, CROSSREF_DOI_BODY)
  }
  if (url.pathname.startsWith('/crossref/')) return send(200, CROSSREF_DOI_BODY)
  if (url.pathname === '/arxiv') {
    hitCount.arxiv += 1
    if (url.searchParams.get('id_list') !== null) return send(200, ARXIV_ATOM, 'application/atom+xml')
    return send(500, { error: '故意失败' })
  }
  return send(404, { error: 'not found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

setAllowedHosts(['127.0.0.1'])
setFetch(globalThis.fetch)
setEndpoints({ openalex: `${base}/openalex`, crossref: `${base}/crossref`, arxiv: `${base}/arxiv` })

try {
  console.log('\n[1] 白名单与注入')
  {
    const { fetchRaw } = await import('../lib/net.js')
    let denied = null
    try {
      await fetchRaw('https://api.openalex.org/works?search=x')
    } catch (e) {
      denied = e
    }
    check('不在白名单的主机被拒', denied !== null && String(denied.message).includes('白名单'), String(denied))
  }

  console.log('\n[2] 多源并发：单源失败不影响其它源')
  {
    hitCount.openalex = 0
    hitCount.crossref = 0
    hitCount.arxiv = 0
    const result = await discover('空气质量预测', { limit: 5 })
    check('三个源都去请求了', hitCount.openalex >= 1 && hitCount.crossref >= 1 && hitCount.arxiv >= 1, JSON.stringify(hitCount))
    check('openalex 报 ok', result.sources.find((s) => s.name === 'openalex')?.status === 'ok')
    check('crossref 报 ok', result.sources.find((s) => s.name === 'crossref')?.status === 'ok')
    check('arxiv 报 failed', result.sources.find((s) => s.name === 'arxiv')?.status === 'failed')
    check('失败的源带错误原因', typeof result.sources.find((s) => s.name === 'arxiv')?.error === 'string')
    check('结果没被失败源搞没', result.items.length >= 2, String(result.items.length))
  }

  console.log('\n[3] 合并去重（DOI 相同只留一条）')
  {
    const result = await discover('空气质量预测', { limit: 5, sources: ['openalex', 'crossref'] })
    const same = result.items.filter((item) => item.doi === '10.1000/abc')
    check('DOI 相同的只留一条', same.length === 1, String(same.length))
    check('合并了两边的来源标记', (same[0]?.sources ?? []).length >= 2, JSON.stringify(same[0]?.sources))
    check('引用数取较大值', same[0]?.citations === 30, String(same[0]?.citations))
    check('另一篇也进来了', result.items.some((item) => item.doi === '10.1000/xyz'))
    check('DOI 被归一成小写', result.items.every((item) => item.doi === '' || item.doi === item.doi.toLowerCase()))
  }

  console.log('\n[4] 指定源')
  {
    const only = await discover('x', { limit: 3, sources: ['crossref'] })
    check('只请求 crossref', only.sources.length === 1 && only.sources[0].name === 'crossref')
    const unknown = await discover('x', { limit: 3, sources: ['nope'] })
    check('未知源自动回落到全部源', unknown.sources.length === 3, String(unknown.sources.length))
  }

  console.log('\n[5] 单个解析函数')
  {
    check('倒排索引复原摘要', abstractFromInvertedIndex({ 空气: [0], 质量: [1] }) === '空气 质量')
    const parsed = parseArxivAtom(ARXIV_ATOM)
    check('解析出 1 条 arXiv 记录', parsed.length === 1, String(parsed.length))
    check('arXiv id 正确', parsed[0].arxivId === '2401.12345v1', parsed[0].arxivId)
    check('arXiv 年份正确', parsed[0].year === 2024, String(parsed[0].year))
    check('arXiv 摘要正确', parsed[0].abstract.includes('LSTM'), parsed[0].abstract)

    const doi = await resolveDoi('10.1000/abc')
    check('resolveDoi 拿到标题', doi.title.includes('空气质量'), doi.title)
    check('resolveDoi 去掉摘要里的标签', !doi.abstract.includes('<'), doi.abstract)
    check('resolveDoi 归一化 DOI', doi.doi === '10.1000/abc')

    const arxiv = await resolveArxiv('2401.12345')
    check('resolveArxiv 拿到标题', arxiv.title.includes('命名实体识别'), arxiv.title)
  }

  console.log('\n[6] 快速添加的输入解析（FR-1.7）')
  {
    const cases = [
      ['10.1000/abc', 'doi'],
      ['https://doi.org/10.1000/abc', 'doi'],
      ['doi:10.1000/abc', 'doi'],
      ['2401.12345', 'arxiv'],
      ['2401.12345v2', 'arxiv'],
      ['arxiv:2401.12345', 'arxiv'],
      ['https://arxiv.org/abs/2401.12345', 'arxiv'],
      ['https://arxiv.org/pdf/2401.12345v1', 'arxiv'],
      ['https://example.com/paper', 'url'],
    ]
    for (const [input, kind] of cases) {
      const parsed = parseInputTarget(input)
      check(`${input} → ${kind}`, parsed?.kind === kind, JSON.stringify(parsed))
    }
    check('认不出的返回 null', parseInputTarget('随便一段中文') === null)
    check('空串返回 null', parseInputTarget('') === null)
    check('arXiv 链接去掉了版本号', parseInputTarget('https://arxiv.org/abs/2401.12345v2')?.value === '2401.12345')
  }

  console.log('\n[7] mergeItems 的字段补齐')
  {
    const merged = mergeItems([
      { items: [{ title: 'A', doi: '', year: null, venue: '', abstract: '', citations: 1, source: 'openalex' }] },
      { items: [{ title: 'A', doi: '10.1/x', year: 2020, venue: 'V', abstract: 'abs', citations: 9, source: 'crossref' }] },
    ])
    check('标题相同的合并成一条', merged.length === 1, String(merged.length))
    check('补齐了 DOI', merged[0].doi === '10.1/x')
    check('补齐了年份', merged[0].year === 2020)
    check('引用取大值', merged[0].citations === 9)
  }
  console.log('\n[8] 检索源可选 + 年份/引用数过滤（FR-6.8）')
  {
    const swapped = normalizeDiscoverFilters({ yearFrom: 2024, yearTo: 2020 })
    check('yearFrom > yearTo 自动交换', swapped.yearFrom === 2020 && swapped.yearTo === 2024, JSON.stringify(swapped))
    check('无效年份当没传', normalizeDiscoverFilters({ yearFrom: 'abc' }).yearFrom === null)
    check('minCitations=0 表示不过滤', normalizeDiscoverFilters({ minCitations: 0 }).minCitations === null)

    const yearOnly = await discover('x', { limit: 5, sources: ['crossref'], yearFrom: 2022, yearTo: 2022 })
    check('年份过滤只留 2022 的 1 条', yearOnly.items.length === 1 && yearOnly.items[0].doi === '10.1000/abc', JSON.stringify(yearOnly.items.map((item) => item.doi)))
    check('剔除了 2021 的 1 条', yearOnly.filters.dropped.year === 1, JSON.stringify(yearOnly.filters.dropped))
    check('filters 回显年份区间', yearOnly.filters.yearFrom === 2022 && yearOnly.filters.yearTo === 2022)

    const cited = await discover('x', { limit: 5, sources: ['crossref'], minCitations: 10 })
    check('引用 ≥10 只留 30 引用的那条', cited.items.length === 1 && cited.items[0].citations === 30, JSON.stringify(cited.items.map((item) => [item.doi, item.citations])))
    check('剔除了 5 引用的 1 条', cited.filters.dropped.citations === 1, JSON.stringify(cited.filters.dropped))

    const parsed = parseArxivAtom(ARXIV_ATOM)[0]
    check('arXiv 引用数是 null（未知）而不是 0', parsed.citations === null, String(parsed.citations))
    const applied = filterCandidates([parsed], { minCitations: 1 })
    check('未知引用数在启用过滤时被剔除', applied.items.length === 0 && applied.dropped.citations === 1, JSON.stringify(applied.dropped))

    await discover('x', { limit: 5, sources: ['openalex'], yearFrom: 2022, yearTo: 2022, minCitations: 5 })
    const openalexUrl = [...hitUrls].reverse().find((item) => item.startsWith('/openalex')) ?? ''
    const decodedOpenAlex = decodeURIComponent(openalexUrl)
    check('OpenAlex 请求带年份范围', decodedOpenAlex.includes('from_publication_date:2022-01-01') && decodedOpenAlex.includes('to_publication_date:2022-12-31'), decodedOpenAlex)
    check('OpenAlex 请求带引用数下限', decodedOpenAlex.includes('cited_by_count:>4'), decodedOpenAlex)

    check(
      'Crossref 请求带年份范围',
      hitUrls.some((item) => decodeURIComponent(item).includes('from-pub-date:2022-01-01') && decodeURIComponent(item).includes('until-pub-date:2022-12-31')),
      JSON.stringify(hitUrls.filter((item) => item.startsWith('/crossref'))),
    )

    await discover('x', { limit: 3, sources: ['arxiv'], yearFrom: 2020 })
    const arxivUrl = decodeURIComponent([...hitUrls].reverse().find((item) => item.startsWith('/arxiv')) ?? '')
    check('arXiv 请求带 submittedDate 区间', arxivUrl.includes('submittedDate:[202001010000 TO'), arxivUrl)
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
  resetEndpoints()
  setAllowedHosts([
    'api.openalex.org',
    'api.crossref.org',
    'export.arxiv.org',
    'arxiv.org',
    'ar5iv.labs.arxiv.org',
    'doi.org',
  ])
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
