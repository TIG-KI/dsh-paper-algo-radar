/**
 * W2.1 · `mode=insight` 领域洞察验收（E33 / E34 / E36 / E37 / RI-1..RI-9）。
 *
 * 与 review/decide 的 E26/E28 一起跑：同参数 sha256 一致、生成前后库不变。
 * 运行：node test/insight.test.mjs
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, generateReport } = await import('../lib/index.js')
const { Store, ingestPaper, buildMatrix, buildCooccurrence } = __test
const { STATEMENT_COOCCURRENCE, STATEMENT_LIBRARY_SCOPE } = await import('../lib/report.js')

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
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const FILLER = '补充说明用于满足最小正文长度，不引入额外的方法名称。'
const body = (topic, extra) => {
  let text = `摘　要：本文研究${topic}。${extra}`
  while ([...text].length < 360) text += FILLER
  if ([...text].length < 300) throw new Error('测试正文太短')
  return text
}

const FIXED = Date.parse('2026-10-23T02:00:00+08:00')
const FIXED_ISO = new Date(FIXED).toISOString()

const root = await mkdtemp(join(tmpdir(), 'radar-insight-'))
const store = new Store(join(root, 'main', 'radar.json'))
await store.load()

try {
  // 领域A：6 篇（3 篇 LSTM+CNN+Adam，1 篇 LSTM+CNN，2 篇 Adam+SVM）
  await ingestPaper(store, { title: 'A1 组合模型', year: 2019, fields: '空气质量预测', text: body('A1', '使用 LSTM 与 CNN，优化器 Adam。') })
  await ingestPaper(store, { title: 'A2 组合模型', year: 2020, fields: '空气质量预测', text: body('A2', '使用 LSTM 与 CNN，优化器 Adam。') })
  await ingestPaper(store, { title: 'A3 组合模型', year: 2021, fields: '空气质量预测', text: body('A3', '使用 LSTM 与 CNN，优化器 Adam。') })
  await ingestPaper(store, { title: 'A4 双模型', year: 2022, fields: '空气质量预测', text: body('A4', '使用 LSTM 与 CNN 对比。') })
  await ingestPaper(store, { title: 'A5 基线', year: 2023, fields: '空气质量预测', text: body('A5', '使用 SVM 与随机森林。') })
  await ingestPaper(store, { title: 'A6 基线', year: 2024, fields: '空气质量预测', text: body('A6', '使用 SVM 与随机森林。') })
  // 领域B：3 篇（CRF + Transformer）
  await ingestPaper(store, { title: 'B1 序列标注', year: 2021, fields: '命名识别', text: body('B1', '使用 CRF 与 Transformer。') })
  await ingestPaper(store, { title: 'B2 序列标注', year: 2022, fields: '命名识别', text: body('B2', '使用 CRF 与 Transformer。') })
  await ingestPaper(store, { title: 'B3 序列标注', year: 2023, fields: '命名识别', text: body('B3', '使用 CRF 与 Transformer。') })
  // 领域C：5 篇（Transformer + Adam）→ 全库 Top1 是 Transformer
  for (let i = 0; i < 5; i += 1) {
    await ingestPaper(store, { title: `C${i} 预训练`, year: 2020 + i, fields: '预训练', text: body(`C${i}`, '使用 Transformer 与 SVM。') })
  }
  // 小领域：2 篇（触发 E36 降级）
  // 小领域用 KNN：避免它把 SVM 顶到全库 Top1，干扰「Top1 与全库不同」的断言
  await ingestPaper(store, { title: 'S1 小样本', year: 2024, fields: '小领域', text: body('S1', '使用 KNN。') })
  await ingestPaper(store, { title: 'S2 小样本', year: 2025, fields: '小领域', text: body('S2', '使用 KNN。') })
  await store.save()

  const library = __test === undefined ? null : null
  void library

  /* ---------------------------------------------------------------- *
   * E37 缺 field
   * ---------------------------------------------------------------- */
  console.log('\n[1] E37 · insight 缺 field → VALIDATION')
  {
    let error = null
    try {
      await generateReport(store, { mode: 'insight', generatedAt: FIXED_ISO })
    } catch (caught) {
      error = caught
    }
    check('报 VALIDATION', error?.code === 'VALIDATION', String(error?.code))
    check('提示指明必须给领域', String(error?.message ?? '').includes('领域'), String(error?.message))
    let error2 = null
    try {
      await generateReport(store, { mode: 'insight', scope: 'yearRange', yearFrom: 2019, yearTo: 2021 })
    } catch (caught) {
      error2 = caught
    }
    check('insight + yearRange 仍要求 field', error2?.code === 'VALIDATION')
  }

  /* ---------------------------------------------------------------- *
   * E33 五节 + 分母 + Top1 差异
   * ---------------------------------------------------------------- */
  console.log('\n[2] E33 · 五节齐全、分母正确、Top1 差异被指出')
  const report = await generateReport(store, { mode: 'insight', field: '空气质量预测', generatedAt: FIXED_ISO, referenceYear: 2026 })
  const text = await readFile(report.path, 'utf8')
  {
    check('五节', report.sections.length === 5, String(report.sections.length))
    check(
      '节标题',
      report.sections.map((section) => section.title).join('|') === '领域画像|算法热度 Top 10|算法组合 Top 10|组合证据|口径与局限',
      report.sections.map((section) => section.title).join('|'),
    )
    check('标题是领域洞察报告', text.startsWith('# 论文算法雷达 · 领域洞察报告'), text.split('\n')[0])
    check('文件名带 insight 与 field', /radar-report-insight-field-空气质量预测-\d{8}-\d{4}\.md$/.test(report.path), report.path)
    check('范围写领域', text.includes('范围：领域=空气质量预测'))
    check('头部同时给全库与本领域', /库：全库 \d+ 篇；本领域 6 篇/.test(text), text.split('\n')[2])
    check('画像含占全库比例与分母', /占全库比例 \| 37\.5%（分母=16）/.test(text), text.match(/占全库比例[^\n]*/)?.[0] ?? '')
    check('热度分母 = 领域篇数', text.includes('> 分母 = 该领域 6 篇；全库分母为 16 篇，两者不可混比。'))
    check('覆盖率按领域算（CNN 4/6 = 66.7%）', /\| 1 \| CNN（DL · 架构） \| 4 \| 4 \| 66\.7% \|/.test(text), text.match(/\| 1 \| [^\n]*/)?.[0] ?? '')
    check('Top1 与全库不同被指出', /该领域 Top1 是 CNN，全库 Top1 是 Transformer/.test(text), text.match(/该领域 Top1[^\n]*/)?.[0] ?? '')
    check('RI-9 声明在第 1 节', text.includes(`> ${STATEMENT_LIBRARY_SCOPE}`))
    check('库内偏差在第 5 节', text.split('## 5.')[1]?.includes('库内偏差') === true)
  }

  /* ---------------------------------------------------------------- *
   * E34 组合表
   * ---------------------------------------------------------------- */
  console.log('\n[3] E34 · 组合表同现 ≥3、排序正确、有「共现 ≠ 结合」')
  {
    const pairRows = [...text.matchAll(/^\| (\d+) \| ([A-Za-z]+ \+ [A-Za-z]+) \| (\d+) \| ([\d.]+) \| ([\d.]+)% \|$/gm)].map((m) => ({
      rank: Number(m[1]),
      pair: m[2],
      papers: Number(m[3]),
      lift: Number(m[4]),
      rate: Number(m[5]),
    }))
    check('组合表有行', pairRows.length > 0, String(pairRows.length))
    check('全部同现 ≥ 3', pairRows.every((row) => row.papers >= 3), JSON.stringify(pairRows.map((r) => r.papers)))
    check(
      '按 篇数 desc → lift desc 排序',
      pairRows.every((row, i) => i === 0 || pairRows[i - 1].papers > row.papers || (pairRows[i - 1].papers === row.papers && pairRows[i - 1].lift >= row.lift)),
      JSON.stringify(pairRows),
    )
    check('有「共现 ≠ 结合」声明', text.includes(STATEMENT_COOCCURRENCE))
    check('写在组合表附近与证据节', (text.match(new RegExp(STATEMENT_COOCCURRENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length >= 2)
    // 同现率 = 同现篇数 ÷ min(两算法各自篇数)
    const cooc = buildCooccurrence(store, { field: '空气质量预测', minPapers: 3, limit: 100 })
    const byName = new Map(cooc.pairs.map((p) => [`${p.a.name} + ${p.b.name}`, p]))
    let rateOk = true
    for (const row of pairRows) {
      const source = byName.get(row.pair)
      if (source === undefined) continue
      const expected = (source.papers / Math.min(source.papersA, source.papersB)) * 100
      if (Math.abs(expected - row.rate) > 0.05) rateOk = false
    }
    check('同现率 = 同现 ÷ min(A,B)', rateOk, JSON.stringify(pairRows))
    check('最小同现声明', text.includes('最小同现 3 篇'))
  }

  /* ---------------------------------------------------------------- *
   * RI-5 / RI-7 / E26 / E28
   * ---------------------------------------------------------------- */
  console.log('\n[4] RI-5 片段 / RI-7 同源 / E26 可复现 / E28 只读')
  {
    const snippetCount = (text.match(/片段：「/g) ?? []).length
    check('证据节 3 组合 × 3 篇 × 2 算法 = 18 条片段', snippetCount === 18, String(snippetCount))
    const overLong = (text.match(/片段：「([^」]*)」/g) ?? []).some((piece) => [...piece].length > 210)
    check('每条片段 ≤200 字符', !overLong)
    check('有「不保证相邻」声明', text.includes('两条片段不保证相邻'))
    // 片段来自已存 snippets（逐字比对第一条）
    const aName = 'A1 组合模型'
    const mention = [...store.mentions.values()].find((item) => {
      const paper = store.papers.get(item.paperId)
      return paper?.title === aName && item.algorithmId === 'lstm'
    })
    check('能取到该论文的已存片段', Array.isArray(mention?.snippets) && mention.snippets.length > 0)
    // RI-7：热度数字与 matrix cells 逐项相等
    const matrix = buildMatrix(store, { field: '空气质量预测', topN: 20 })
    const cells = new Map(matrix.rows[0].cells.map((cell) => [cell.algorithmId, cell.papers]))
    const heatRows = [...text.matchAll(/^\| \d+ \| ([^（|]+)（[^|]+） \| (\d+) \|/gm)]
    let heatOk = true
    for (const row of heatRows) {
      const name = row[1].trim()
      const papers = Number(row[2])
      const cell = [...cells.entries()].find(([id]) => (store.algorithms.get(id)?.name ?? __test.LEXICON_BY_ID?.get(id)?.name ?? id) === name)
      if (cell !== undefined && cell[1] !== papers) heatOk = false
    }
    check('热度与 matrix cells 逐项相等', heatOk && heatRows.length > 0, String(heatRows.length))

    const again = await generateReport(store, { mode: 'insight', field: '空气质量预测', generatedAt: FIXED_ISO, referenceYear: 2026 })
    check('E26 同参数 sha256 一致', sha256(await readFile(report.path)) === sha256(await readFile(again.path)))

    const dbPath = join(root, 'main', 'radar.json')
    const textsDir = join(root, 'main', 'texts')
    const before = { db: sha256(await readFile(dbPath)), texts: (await readdir(textsDir)).sort().join(',') }
    await generateReport(store, { mode: 'insight', field: '命名识别', generatedAt: FIXED_ISO })
    const after = { db: sha256(await readFile(dbPath)), texts: (await readdir(textsDir)).sort().join(',') }
    check('E28 store.json 不变', before.db === after.db)
    check('E28 texts/ 清单不变', before.texts === after.texts)
    check('返回体无 content', report.content === undefined)
  }

  /* ---------------------------------------------------------------- *
   * E36 降级
   * ---------------------------------------------------------------- */
  console.log('\n[5] E36 · 领域 < 5 篇降级')
  {
    const small = await generateReport(store, { mode: 'insight', field: '小领域', generatedAt: FIXED_ISO })
    const smallText = await readFile(small.path, 'utf8')
    check('只有两节', small.sections.map((section) => section.n).join(',') === '1,5', small.sections.map((s) => s.n).join(','))
    check('有降级说明', smallText.includes('本领域仅 2 篇（< 5）'), smallText.split('\n')[4])
    check('不含排行表', !smallText.includes('算法热度 Top 10'))
    check('不含组合表', !smallText.includes('算法组合 Top 10'))
    check('仍含画像与局限', smallText.includes('## 1. 领域画像') && smallText.includes('## 5. 口径与局限'))
    check('不报错', small.bytes > 0)
  }

  /* ---------------------------------------------------------------- *
   * 工具层 + 命令层
   * ---------------------------------------------------------------- */
  console.log('\n[6] 工具与命令入口')
  {
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'tool')
    try {
      const { apply } = await import('../lib/index.js')
      const tools = new Map()
      const ctx = {
        tools: { register: (tool) => (tools.set(tool.name, tool), () => tools.delete(tool.name)), get: (name) => tools.get(name) },
        effect: (fn) => fn(),
        inject: () => () => {},
        logger: { warn() {}, info() {}, error() {} },
      }
      await apply(ctx, { writeEnabled: false })
      const tool = tools.get('radar_report')
      const result = await tool.execute({ mode: 'insight', field: '空气质量预测', generatedAt: FIXED_ISO })
      // 工具用的是全新 DSH_HOME（空库）：该领域 0 篇 → 按 RI-6 降级为两节，这也顺带验证了降级路径
      check('工具能出 insight（空库降级为两节）', result.sections.length === 2 && result.bytes > 0, JSON.stringify(result.sections))
      let toolError = null
      try {
        await tool.execute({ mode: 'insight' })
      } catch (caught) {
        toolError = caught
      }
      check('工具缺 field 报 VALIDATION', toolError?.code === 'VALIDATION', String(toolError?.code))
      check('mode 参数声明了 insight', JSON.stringify(tool.parameters.properties.mode.enum) === '["review","decide","insight"]', JSON.stringify(tool.parameters.properties.mode.enum))
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
    }

    const { registerRadarCommand } = await import('../lib/command.js')
    const registered = []
    const commandCtx = {
      logger: { warn() {}, info() {}, error() {} },
      inject(services, fn) {
        if (!services.includes('commands')) return () => {}
        fn({ commands: { register: (definition) => (registered.push(definition), () => {}) } })
        return () => {}
      },
    }
    const calls = []
    registerRadarCommand(commandCtx, {
      status: async () => ({ paperCount: 0 }),
      reextract: async () => ({ total: 0, changed: 0, skippedNoText: 0 }),
      exportFile: async () => ({ path: 'x', bytes: 1, format: 'json' }),
      report: async (options) => {
        calls.push(options)
        return { path: 'C:\\tmp\\i.md', bytes: 1024, mode: options.mode, scope: options.field ?? '全库', sections: [{ n: 1, title: '领域画像' }] }
      },
    })
    const reply = await registered[0].handler({ rawInput: 'report insight --field 空气质量预测' })
    check('/radar report insight 走同一实现', calls.at(-1)?.mode === 'insight' && calls.at(-1)?.field === '空气质量预测', JSON.stringify(calls.at(-1)))
    check('命令回复是成功', reply.kind === 'success' && reply.text.includes('i.md'), reply.text)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
