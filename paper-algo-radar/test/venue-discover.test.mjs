/**
 * W2.2 验收 · E43 / E44：venue 白名单过滤与 insight 分层边界。
 *
 * 网络全部走 `setFetch()` 假 OpenAlex 响应，不碰真网。
 * 运行：node test/venue-discover.test.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, generateReport } = await import('../lib/index.js')
const { Store, ingestPaper, buildDiscoverTool } = __test
const { setFetch } = await import('../lib/net.js')
const { normalizeVenue } = await import('../lib/venue.js')

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

/** 假 OpenAlex：按 query 返回不同批次，避免 5 分钟缓存串味。 */
const batches = new Map()
function openAlexItems(query, venues) {
  return venues.map((venue, index) => ({
    id: `https://openalex.org/W${query.replace(/\D/g, '')}${String(index).padStart(3, '0')}`,
    doi: `https://doi.org/10.9999/${query.replace(/\s+/g, '')}.${index}`,
    title: `${query} paper ${index}`,
    publication_year: 2024,
    primary_location: { source: { display_name: venue } },
    cited_by_count: index,
    abstract_inverted_index: null,
  }))
}

const fakeFetch = async (url) => {
  const target = String(url)
  const query = new URL(target).searchParams.get('search') ?? ''
  const items = batches.get(query) ?? []
  return new Response(JSON.stringify({ results: items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const fakeCtx = { tools: { get: () => undefined, execute: async () => null }, logger: { warn() {}, info() {}, error() {} } }

const root = await mkdtemp(join(tmpdir(), 'radar-venue-'))
const store = new Store(join(root, 'radar.json'))
await store.load()
const getStore = async () => store
const discover = buildDiscoverTool(getStore, fakeCtx)

try {
  setFetch(fakeFetch)

  /* ---------------- E43 · allowlist 过滤 ---------------- */
  console.log('\n[1] E43 · items 只含命中，未命中进 excluded[]')
  {
    const venues = [
      ...Array.from({ length: 12 }, () => 'IEEE/CVF CVPR'),
      ...Array.from({ length: 8 }, () => 'ICML 2024'),
      ...Array.from({ length: 5 }, () => ''),
    ]
    batches.set('cvpr-mix', openAlexItems('cvpr-mix', venues))
    const result = await discover.execute({
      query: 'cvpr-mix',
      sources: ['openalex'],
      limit: 20,
      venueAllowlist: ['CVPR'],
    })
    check('items 只含白名单命中', result.items.length === 12, String(result.items.length))
    check('命中项 venue 归一后是 CVPR', result.items.every((item) => normalizeVenue(item.venue) === 'CVPR'))
    check('excludedCount = 13', result.excludedCount === 13, String(result.excludedCount))
    check('excluded 明细完整（≤20）', result.excluded.length === 13, String(result.excluded.length))
    check('excluded 未截断', result.excludedTruncated === false)
    const notIn = result.excluded.filter((row) => row.reason === 'not-in-allowlist')
    const missing = result.excluded.filter((row) => row.reason === 'venue-missing')
    check('reason 分类：8 不在白名单', notIn.length === 8, String(notIn.length))
    check('reason 分类：5 无 venue', missing.length === 5, String(missing.length))
    check('excluded 带 title/venue/venueNorm/reason', result.excluded.every((row) => 'title' in row && 'venue' in row && 'venueNorm' in row && 'reason' in row))
    check('空 venue 的 venueNorm 为 null', missing.every((row) => row.venueNorm === null))
  }

  /* ---------------- E43 · 截断 ---------------- */
  console.log('\n[2] E43 · 被滤超过 20 条 → excludedTruncated')
  {
    const venues = [...Array.from({ length: 2 }, () => 'Proceedings of CVPR'), ...Array.from({ length: 23 }, () => ' ICCV 2023')]
    batches.set('cvpr-trunc', openAlexItems('cvpr-trunc', venues))
    const result = await discover.execute({
      query: 'cvpr-trunc',
      sources: ['openalex'],
      limit: 20,
      venueAllowlist: ['CVPR 2024'],
    })
    check('命中 2 条', result.items.length === 2, String(result.items.length))
    check('excludedCount = 23', result.excludedCount === 23, String(result.excludedCount))
    check('excluded 截到 20 条', result.excluded.length === 20, String(result.excluded.length))
    check('excludedTruncated = true', result.excludedTruncated === true)
  }

  /* ---------------- E43 · 不传参数与改动前一致 ---------------- */
  console.log('\n[3] E43 · 不传 venueAllowlist → 不过滤')
  {
    batches.set('plain', openAlexItems('plain', ['CVPR 2024', 'ICML', '', 'NeurIPS']))
    const withoutParam = await discover.execute({ query: 'plain', sources: ['openalex'], limit: 20 })
    const withEmpty = await discover.execute({ query: 'plain', sources: ['openalex'], limit: 20, venueAllowlist: [] })
    check('不传时 4 条全返回', withoutParam.items.length === 4, String(withoutParam.items.length))
    check('不传时 excluded 为空', withoutParam.excluded.length === 0 && withoutParam.excludedCount === 0)
    check('不传时 excludedTruncated=false', withoutParam.excludedTruncated === false)
    check('传空数组也等于不过滤（E44）', JSON.stringify(withEmpty.items) === JSON.stringify(withoutParam.items))
  }

  /* ---------------- E44 · insight 边界 ---------------- */
  console.log('\n[4] E44 · insight(venueScope=allowlist) 边界')
  {
    const iso = new Date(Date.parse('2026-10-23T03:00:00+08:00')).toISOString()
    let blank = null
    try {
      await generateReport(store, { mode: 'insight', field: '空气质量', venueScope: 'allowlist', generatedAt: iso })
    } catch (error) {
      blank = error
    }
    check('空白名单 → VALIDATION', blank?.code === 'VALIDATION', String(blank?.code))
    check('提示指向 venueAllowlist', String(blank?.message ?? '').includes('venueAllowlist'), String(blank?.message))

    let windowed = null
    try {
      await generateReport(store, { mode: 'insight', field: '空气质量', yearFrom: 2020, generatedAt: iso })
    } catch (error) {
      windowed = error
    }
    check('insight 带 yearFrom → VALIDATION', windowed?.code === 'VALIDATION', String(windowed?.code))
    let windowed2 = null
    try {
      await generateReport(store, { mode: 'insight', field: '空气质量', windowDays: 30, generatedAt: iso })
    } catch (error) {
      windowed2 = error
    }
    check('insight 带 windowDays → VALIDATION', windowed2?.code === 'VALIDATION', String(windowed2?.code))
  }

  /* ---------------- insight venueScope=allowlist 分层 ---------------- */
  console.log('\n[5] insight(venueScope=allowlist) · 两张 Top10 与各自分母')
  {
    // 领域内：4 篇 CVPR（LSTM+CNN）、3 篇 ICML（SVM）、1 篇无 venue（CRF）
    const FILLER = '补充说明用于满足最小正文长度，不引入额外的方法名称。'
    const body = (topic, extra) => {
      let text = `摘　要：本文研究${topic}。${extra}`
      while ([...text].length < 360) text += FILLER
      return text
    }
    for (let i = 0; i < 4; i += 1) {
      await ingestPaper(store, { title: `CVPR 论文 ${i}`, year: 2024, venue: 'IEEE/CVF CVPR', fields: '空气质量', text: body(`cvpr${i}`, '使用 LSTM 与 CNN。') })
    }
    for (let i = 0; i < 3; i += 1) {
      await ingestPaper(store, { title: `ICML 论文 ${i}`, year: 2024, venue: 'ICML 2024', fields: '空气质量', text: body(`icml${i}`, '使用 SVM。') })
    }
    await ingestPaper(store, { title: '无 venue 论文', year: 2024, venue: '', fields: '空气质量', text: body('nove', '使用 CRF。') })
    await store.save()

    const iso = new Date(Date.parse('2026-10-23T03:00:00+08:00')).toISOString()
    const report = await generateReport(store, {
      mode: 'insight',
      field: '空气质量',
      venueScope: 'allowlist',
      venueAllowlist: ['CVPR'],
      generatedAt: iso,
    })
    const text = await readFile(report.path, 'utf8')
    check('仍是五节', report.sections.length === 5, String(report.sections.length))
    check('第 2 节拆成两张表', text.includes('### 白名单内 Top10') && text.includes('### 白名单外 Top10'))
    check('白名单内分母 = 4', text.includes('> 分母 = 白名单内 4 篇。'), (text.match(/> 分母 = 白名单内[^\n]*/) ?? [''])[0])
    check('白名单外分母 = 4', text.includes('> 分母 = 白名单外 4 篇。'), (text.match(/> 分母 = 白名单外[^\n]*/) ?? [''])[0])
    check('venue 未标注 1 篇', text.includes('> 其中 venue 未标注 1 篇。'), (text.match(/> 其中 venue 未标注[^\n]*/) ?? [''])[0])
    check('固定声明「范围 ≠ 质量」', text.includes('> 白名单只表示检索范围，不表示论文质量。'))
    check('第 5 节声明组合未按白名单过滤', text.includes('第 3 节组合基于领域全集，未按白名单过滤'))
    check('第 1 节有来源构成行', /来源构成 \| /.test(text), (text.match(/来源构成 \|[^\n]*/) ?? [''])[0])
    check('第 3 节仍用领域全集（组合表存在）', text.includes('## 3. 算法组合 Top 10'))

    // venueScope=all（默认）与 W2.1 一致：单表
    const plain = await generateReport(store, { mode: 'insight', field: '空气质量', generatedAt: iso })
    const plainText = await readFile(plain.path, 'utf8')
    check('默认 all 仍是单表', !plainText.includes('### 白名单内 Top10'))
    check('默认 all 分母 = 领域 8 篇', plainText.includes('> 分母 = 该领域 8 篇'), (plainText.match(/> 分母 = 该领域[^\n]*/) ?? [''])[0])
  }
} finally {
  setFetch(null)
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
