/**
 * W2.2 验收 · FR-14 登记溯源（E38/E39）+ FR-15 采集契约（E40/E41 前半）+ FR-16.1 归一（E42）。
 *
 * 网络全部走 `setFetch()` 假响应，不碰真网络。
 * E41 的「报告分列已读/未读」与 E43（discover venueAllowlist 语义）需口径确认后单独实现，见交付说明。
 *
 * 运行：node test/provenance.test.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, generateReport } = await import('../lib/index.js')
const { Store, buildAddTool, buildAddBatchTool, buildPapersTool, buildStatusTool } = __test
const { setFetch } = await import('../lib/net.js')
const { normalizeVenue, venueInAllowlist, allowlistSet } = await import('../lib/venue.js')

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

const FILLER = '补充说明用于满足最小正文长度，不引入额外的方法名称。'
const body = (topic, extra) => {
  let text = `摘　要：本文研究${topic}。${extra}`
  while ([...text].length < 360) text += FILLER
  if ([...text].length < 300) throw new Error('测试正文太短')
  return text
}

/* ---------------- 假网络：Crossref / arXiv ---------------- */
const CROSSREF_DOI = '10.1234/radar.test'
const ARXIV_ID = '2401.99999'
const fakeFetch = async (url) => {
  const target = String(url)
  if (target.includes('api.crossref.org')) {
    return new Response(
      JSON.stringify({
        message: {
          title: ['A Test Paper on Air Quality Prediction'],
          issued: { 'date-parts': [[2024, 5, 1]] },
          'container-title': ['IEEE/CVF CVPR'],
          DOI: CROSSREF_DOI,
          URL: 'https://doi.org/' + CROSSREF_DOI,
          abstract: body('空气', '使用 LSTM 与 CNN 做预测。'),
          'is-referenced-by-count': 7,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  if (target.includes('export.arxiv.org')) {
    return new Response(
      `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/${ARXIV_ID}v1</id>` +
        `<title>An arXiv Test Paper</title><published>2023-06-01T00:00:00Z</published>` +
        `<summary>${body('arXiv 样本', '使用 CRF 与 Transformer。')}</summary></entry></feed>`,
      { status: 200, headers: { 'content-type': 'application/atom+xml' } },
    )
  }
  // arXiv 全文抓取：返回空壳，让 registerCandidate 回落到摘要
  return new Response('<html><body></body></html>', { status: 200 })
}

const root = await mkdtemp(join(tmpdir(), 'radar-prov-'))
const store = new Store(join(root, 'radar.json'))
await store.load()
const getStore = async () => store
const add = buildAddTool(getStore)
const addBatch = buildAddBatchTool(getStore)
const papers = buildPapersTool(getStore)
const status = buildStatusTool(getStore)

try {
  setFetch(fakeFetch)

  /* ---------------- E38 六种入口 ---------------- */
  console.log('\n[1] E38 · 六种入口的 source 推断')

  const doiResult = await add.execute({ input: CROSSREF_DOI })
  check('DOI 入口 → doi', doiResult.paper?.source === 'doi', String(doiResult.paper?.source))

  const arxivResult = await add.execute({ input: ARXIV_ID })
  check('arXiv 入口 → arxiv', arxivResult.paper?.source === 'arxiv', String(arxivResult.paper?.source))

  const manualResult = await add.execute({ title: '手工粘贴的论文', text: body('手工样本', '使用 SVM。') })
  check('text 入口 → manual', manualResult.paper?.source === 'manual', String(manualResult.paper?.source))

  const zoteroResult = await add.execute({
    title: '从 Zotero 取来的论文',
    text: body('Zotero 样本', '使用 MLP。'),
    source: 'zotero',
  })
  check('显式 zotero 覆盖成功', zoteroResult.paper?.source === 'zotero', String(zoteroResult.paper?.source))

  const skillResult = await add.execute({
    title: '别的 skill 检索后登记的论文',
    text: body('skill 样本', '使用 KNN。'),
    source: 'skill',
  })
  check('显式 skill 覆盖成功', skillResult.paper?.source === 'skill', String(skillResult.paper?.source))

  const batchResult = await addBatch.execute({
    items: [{ title: '批量检索进来的论文', abstract: body('批量样本', '使用 Adam。'), year: 2024, fields: '批量' }],
  })
  check('add_batch 入口 → search', batchResult.results?.[0]?.ok === true)
  const batchPaper = [...store.papers.values()].find((paper) => paper.title === '批量检索进来的论文')
  check('批量论文落库 source=search', batchPaper?.source === 'search', String(batchPaper?.source))

  // PDF 入口：造一个最小 PDF
  const pdfText = body('PDF 样本', '使用 LSTM。')
  const pdfBytes = (() => {
    // 与 test/pdf.test.mjs 同款：逐行 BT/Td/Tj，非 ASCII 用 <UTF-16BE hex>（真实 PDF 就这么存中文）
    const lines = pdfText.match(/.{1,60}/g) ?? []
    let content = ''
    lines.forEach((line, index) => {
      const isAscii = [...line].every((ch) => ch.codePointAt(0) < 0x80)
      let shown
      if (isAscii) {
        shown = `(${line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
      } else {
        const hex = [...line].map((ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
        shown = `<${hex}>`
      }
      content += `BT /F1 12 Tf 72 ${740 - index * 16} Td ${shown} Tj ET\n`
    })
    const contentBytes = Buffer.from(content, 'latin1')
    const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    ]
    const head = Buffer.from(`%PDF-1.4\n${objects.join('')}4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`, 'latin1')
    const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')
    return Buffer.concat([head, contentBytes, tail])
  })()
  const pdfPath = join(root, 'sample.pdf')
  await writeFile(pdfPath, pdfBytes)
  let pdfResult = null
  let pdfError = null
  try {
    pdfResult = await add.execute({ pdfPath })
  } catch (error) {
    pdfError = error
  }
  check('PDF 入口 → pdf', pdfResult?.paper?.source === 'pdf', pdfResult ? String(pdfResult.paper.source) : String(pdfError?.message))

  /* ---------------- E39 存量数据 ---------------- */
  console.log('\n[2] E39 · 存量论文 source=null，不推断不回填')
  {
    // 模拟「早于来源追踪」的旧记录：没有 source / status 字段
    store.papers.set('p_legacy0000000001', {
      id: 'p_legacy0000000001',
      dedupeKey: 'legacy',
      title: '早于来源追踪的论文',
      year: 2020,
      venue: 'CVPR 2020',
      fields: ['历史'],
      depth: 'abstract',
      chars: 400,
      hitCount: 0,
      hasText: false,
      readAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    })
    await store.save()
    const list = await papers.execute({ limit: 50 })
    const legacy = list.items.find((item) => item.id === 'p_legacy0000000001')
    check('旧记录读出 source=null', legacy?.source === null, String(legacy?.source))
    check('旧记录读出 status=null', legacy?.status === null, String(legacy?.status))
    const snapshot = await status.execute()
    check('status 里有来源分布', snapshot.sourceCounts !== undefined)
    check('null 单独计数', snapshot.sourceCounts?.null >= 1, JSON.stringify(snapshot.sourceCounts))
    check('存量不报错', snapshot.paperCount > 0)
    // 不回填：再读一次仍是 null
    const again = await papers.execute({ source: 'null', limit: 50 })
    check('source=null 过滤能查到存量', again.items.some((item) => item.id === 'p_legacy0000000001'))
    check('存量没有被回填成其它渠道', (store.papers.get('p_legacy0000000001')?.source ?? null) === null)
  }

  /* ---------------- E40 幂等 ---------------- */
  console.log('\n[3] E40 · 同一批 add_batch 连跑两次，第二次新增 0')
  {
    // 注意：add_batch 走 normalizeCandidate，只认 title/abstract/doi/arxivId 等元数据，
    // 传 text 会被丢掉（这不是本工单的范围，测试按真实契约走 abstract）
    const items = [
      { title: '幂等测试 A', abstract: body('幂等A', '使用 LSTM。'), year: 2024 },
      { title: '幂等测试 B', abstract: body('幂等B', '使用 CNN。'), year: 2024 },
    ]
    const firstRun = await addBatch.execute({ items })
    const secondRun = await addBatch.execute({ items })
    const createdOf = (run) => run.results.filter((row) => row.ok && row.created === true).length
    check('第一次新增 2', createdOf(firstRun) === 2, String(createdOf(firstRun)))
    check('第二次新增 0', createdOf(secondRun) === 0, String(createdOf(secondRun)))
    check('第二次全部成功（更新而非报错）', secondRun.results.every((row) => row.ok === true))
    const total = [...store.papers.values()].filter((paper) => /^幂等测试/.test(paper.title)).length
    check('库里仍是 2 篇', total === 2, String(total))
  }

  /* ---------------- E41 前半：定时采集默认待读 ---------------- */
  console.log('\n[4] E41（前半）· 定时采集 status=toread')
  {
    const searchRun = await addBatch.execute({
      source: 'search',
      items: [{ title: '定时采集 search', abstract: body('定时search', '使用 Adam。'), year: 2025 }],
    })
    check('search 批量成功', searchRun.results?.[0]?.ok === true)
    const searchPaper = [...store.papers.values()].find((paper) => paper.title === '定时采集 search')
    check('search → status=toread', searchPaper?.status === 'toread', String(searchPaper?.status))

    const skillRun = await addBatch.execute({
      source: 'skill',
      items: [{ title: '定时采集 skill', abstract: body('定时skill', '使用 SVM。'), year: 2025 }],
    })
    check('skill 批量成功', skillRun.results?.[0]?.ok === true)
    const skillPaper = [...store.papers.values()].find((paper) => paper.title === '定时采集 skill')
    check('skill → status=toread', skillPaper?.status === 'toread', String(skillPaper?.status))

    const manual = await add.execute({ title: '手动手工', text: body('手工2', '使用 KNN。') })
    check('manual → done（D-2：其余入口默认已读）', manual.paper?.status === 'done', String(manual.paper?.status))
    check('pdf → done', pdfResult?.paper?.status === 'done', String(pdfResult?.paper?.status))

    const explicit = await add.execute({ title: '显式已读', text: body('已读样本', '使用 MLP。'), status: 'done' })
    check('显式 status=done 生效', explicit.paper?.status === 'done', String(explicit.paper?.status))

    const snapshot = await status.execute()
    check('状态分布可读', snapshot.statusCounts?.toread >= 2, JSON.stringify(snapshot.statusCounts))
    check('done 计数 >= 1', snapshot.statusCounts?.done >= 1, JSON.stringify(snapshot.statusCounts))
    const statusTotal =
      (snapshot.statusCounts?.done ?? 0) +
      (snapshot.statusCounts?.toread ?? 0) +
      (snapshot.statusCounts?.reading ?? 0) +
      (snapshot.statusCounts?.null ?? 0)
    check('状态四态之和 = 论文数', statusTotal === snapshot.paperCount, statusTotal + ' vs ' + snapshot.paperCount)
    const explicitReading = await add.execute({ title: '显式在读', text: body('在读样本', '使用 RNN。'), status: 'reading' })
    check('显式 status=reading 生效', explicitReading.paper?.status === 'reading', String(explicitReading.paper?.status))
  }

  /* ---------------- 参数校验 ---------------- */
  console.log('\n[5] 非法 source / status 直接拒')
  {
    let badSource = null
    try {
      await add.execute({ title: 'x', text: body('x', '使用 LSTM。'), source: 'wechat' })
    } catch (error) {
      badSource = error
    }
    check('非法 source → VALIDATION', badSource?.code === 'VALIDATION', String(badSource?.code))
    let badStatus = null
    try {
      await add.execute({ title: 'y', text: body('y', '使用 LSTM。'), status: 'finished' })
    } catch (error) {
      badStatus = error
    }
    check('非法 status → VALIDATION', badStatus?.code === 'VALIDATION', String(badStatus?.code))
  }

  /* ---------------- E41 报告侧（D-1 三行） ---------------- */
  console.log('[6b] E41 · review 第 2 章三行与库内一致，三行之和 = 总数')
  {
    const iso = new Date(Date.parse('2026-10-23T03:00:00+08:00')).toISOString()
    const report = await generateReport(store, { mode: 'review', generatedAt: iso, referenceYear: 2026 })
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(report.path, 'utf8')
    const snapshot = await status.execute()
    const folded = {
      done: snapshot.statusCounts?.done ?? 0,
      unread: (snapshot.statusCounts?.toread ?? 0) + (snapshot.statusCounts?.reading ?? 0),
      unknown: snapshot.statusCounts?.null ?? 0,
    }
    const readRow = text.match(/\| 已读 \/ 未读 \| (\d+) \/ (\d+)(?:（在读 (\d+) 篇）)? \|/)
    check('第 2 章有「已读 / 未读」行', readRow !== null, (text.match(/\| 已读[^\n]*/) ?? [''])[0])
    check('已读数与库内一致', Number(readRow?.[1]) === folded.done, String(readRow?.[1]) + ' vs ' + folded.done)
    check('未读数 = toread + reading', Number(readRow?.[2]) === folded.unread, String(readRow?.[2]) + ' vs ' + folded.unread)
    const unknownRow = text.match(/\| 状态未知 \| (\d+) 篇 \|/)
    check('状态未知行与库内一致', Number(unknownRow?.[1]) === folded.unknown, String(unknownRow?.[1]) + ' vs ' + folded.unknown)
    check('三行之和 = 论文总数', folded.done + folded.unread + folded.unknown === snapshot.paperCount, JSON.stringify({ folded, total: snapshot.paperCount }))
    check('来源构成行存在', /\| 来源构成 \| (?!—)/.test(text), (text.match(/\| 来源构成[^\n]*/) ?? [''])[0])
    check('来源构成列出 search 与其它渠道', /来源构成 \| .*search \d/.test(text) && /来源构成 \| .*(manual|pdf|doi|arxiv) \d/.test(text), (text.match(/\| 来源构成[^\n]*/) ?? [''])[0])
    check('第 3 章有未读提示', text.includes('> 排行含未读 '), (text.match(/> 排行含未读[^\n]*/) ?? [''])[0])
    const decide = await generateReport(store, { mode: 'decide', generatedAt: iso, referenceYear: 2026 })
    const decideText = await readFile(decide.path, 'utf8')
    check('decide 第 4 章有口径声明', decideText.includes('来源渠道与阅读状态不参与缺口判定'))
  }
  /* ---------------- E42 venue 归一 ---------------- */
  console.log('\n[6] E42 · venue 归一与精确匹配')
  {
    check('CVPR 2024 → CVPR', normalizeVenue('CVPR 2024') === 'CVPR', normalizeVenue('CVPR 2024'))
    check('IEEE/CVF CVPR → CVPR', normalizeVenue('IEEE/CVF CVPR') === 'CVPR', normalizeVenue('IEEE/CVF CVPR'))
    check('Proceedings of CVPR → CVPR', normalizeVenue('Proceedings of CVPR') === 'CVPR', normalizeVenue('Proceedings of CVPR'))
    check('大小写统一', normalizeVenue('cvpr') === 'CVPR', normalizeVenue('cvpr'))
    check(
      '叠加前缀 + 年份也能归一',
      normalizeVenue('In Proceedings of the IEEE/CVF CVPR 2024') === 'CVPR',
      normalizeVenue('In Proceedings of the IEEE/CVF CVPR 2024'),
    )
    check('卷期页码被剥离', normalizeVenue('CVPR, vol. 12, no. 3, pp. 1-10') === 'CVPR', normalizeVenue('CVPR, vol. 12, no. 3, pp. 1-10'))
    const allow = ['CVPR 2024', 'NeurIPS']
    check('白名单内的原始写法也能命中', venueInAllowlist('IEEE/CVF CVPR', allow) === true)
    check('归一后精确匹配（NIPS ≠ NeurIPS）', venueInAllowlist('NIPS', allow) === false)
    check('空 venue 不命中', venueInAllowlist('', allow) === false)
    check('归一失败返回 null（venue-missing）', normalizeVenue('') === null && normalizeVenue('   ') === null, String(normalizeVenue('')))
    check('白名单集合归一', [...allowlistSet(['cvpr', ' NeurIPS '])].join(',') === 'CVPR,NEURIPS', [...allowlistSet(['cvpr', ' NeurIPS '])].join(','))
  }
} finally {
  setFetch(null)
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
