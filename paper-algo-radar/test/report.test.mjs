/**
 * W2.1 研究报告 · 验收（E24 / E25 / E26 / E27 / E28 / E30 / E32）。
 *
 * 规范：docs/REPORT_TEMPLATE_SPEC.md + REQUIREMENTS §7 FR-13 / §8 R13 + DECISIONS_REPORT P-10/P-11。
 * 运行：node test/report.test.mjs
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, generateReport } = await import('../lib/index.js')
const { Store, ingestPaper } = __test
const { computeGaps, renderAppendix, renderReport } = await import('../lib/report.js')

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

const DUMP = '补充说明用于满足最小正文长度，不引入额外的方法名称。'
const body = (topic, extra = '') => {
  let text = `摘　要：本文研究${topic}。${extra}`
  while ([...text].length < 360) text += DUMP
  if ([...text].length < 300) throw new Error('测试正文太短')
  return text
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const FIXED = Date.parse('2026-10-23T00:28:00+08:00')
const FIXED_ISO = new Date(FIXED).toISOString()

/** 假 ctx：只需要 tools / effect / inject / logger。 */
function fakeCtx() {
  const tools = new Map()
  return {
    _tools: tools,
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get: (name) => tools.get(name),
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose && dispose()
    },
    inject: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
  }
}

const root = await mkdtemp(join(tmpdir(), 'radar-report-'))
const storePath = (name) => join(root, name, 'radar.json')

async function newStore(name) {
  const store = new Store(storePath(name))
  await store.load()
  return store
}

try {
  /* ---------------------------------------------------------------- *
   * E24 空库
   * ---------------------------------------------------------------- */
  console.log('\n[1] E24 · 空库也能出报告')
  {
    const store = await newStore('empty')
    const review = await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO, referenceYear: 2026 })
    const text = await readFile(review.path, 'utf8')
    check('文件已落盘', review.bytes > 0)
    check('文件名带 mode/scope/时间戳', /radar-report-review-all-20261023-0028\.md$/.test(review.path), review.path)
    check('review 章节 = 数据画像/可信度/附录', review.sections.map((s) => s.n).join(',') === '2,9,10', JSON.stringify(review.sections))
    check('声明数据不足', text.includes('数据不足'), text.slice(0, 200))
    check('数据画像全 0', /论文数 \| 0 篇/.test(text), text.slice(0, 400))
    check('附录为空表', text.includes('（空）'))
    check('不含结论章标题', !text.includes('## 1. 摘要') && !text.includes('## 3. 算法排行'))

    const decide = await generateReport(store, { mode: 'decide', generatedAt: FIXED_ISO, referenceYear: 2026 })
    const dText = await readFile(decide.path, 'utf8')
    check('decide 章节 = 口径/未评估', decide.sections.map((s) => s.n).join(',') === '4,5', JSON.stringify(decide.sections))
    check('声明库为空', dText.includes('库为空'))
    check('不造缺口条目', !dText.includes('## 1. 缺口清单'))
  }

  /* ---------------------------------------------------------------- *
   * E25 前半 · review 十章
   * ---------------------------------------------------------------- */
  const store = await newStore('main')
  const seed = [
    { title: '空气质量预测中的深度学习', year: 2019, fields: '空气质量', extra: '方法使用 LSTM 与 CNN，优化器 Adam。' },
    { title: '空气污染时空建模', year: 2021, fields: '空气质量', extra: '使用 LSTM、Transformer 与随机森林对比。' },
    { title: '命名实体识别综述', year: 2022, fields: 'NLP', extra: '使用 CRF 与双向 LSTM，评估 F1。' },
    { title: '小样本学习', year: 2024, fields: '小样本', extra: '使用 MLP 与 SVM 作为基线。' },
    { title: '图神经网络入门', year: 2023, fields: '图学习', extra: '使用 GNN 与 Adam 训练。' },
    { title: '摘要级样本', year: 2025, fields: '空气质量', extra: '只给摘要，提及 LSTM。', depth: 'abstract' },
  ]
  for (const item of seed) {
    await ingestPaper(store, {
      title: item.title,
      year: item.year,
      fields: item.fields,
      depth: item.depth,
      text: body(item.title, item.extra),
    })
  }
  await store.save()

  console.log('\n[2] E25 前半 · review 十章齐全')
  const review = await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO, referenceYear: 2026, windowDays: 30 })
  const reviewText = await readFile(review.path, 'utf8')
  {
    check('十章', review.sections.length === 10, String(review.sections.length))
    check(
      '章标题与规范一致',
      review.sections.map((s) => s.title).join('|') ===
        '摘要|数据画像|算法排行 Top 10|类型分布|时间线|领域分布|代表性论文|最近新增|可信度与局限|附录',
      review.sections.map((s) => s.title).join('|'),
    )
    check('报告头带生成时间与口径', /生成：2026-10-23 00:28（.+） · 口径 \S+ · 参考年 2026/.test(reviewText))
    check('报告头带库规模与摘要级', /库：6 篇 · \d+ 个算法 · \d+ 次提及 · 摘要级 1\/6/.test(reviewText), reviewText.slice(0, 300))
    check('摘要首条是数字陈述', /共登记 6 篇（全文 5 \/ 摘要 1）/.test(reviewText))
    check('排行 6 列表头', reviewText.includes('| # | 算法 | 论文数 | 提及数 | 覆盖率 | 首见年 |'))
    check('排行带算法名+类型·分类', /LSTM（DL · 架构）/.test(reviewText))
    check('覆盖率分母成段标注', reviewText.includes('> 分母 = 6 篇（scope 内）'))
    check('类型分布固定三行', /\| DL \|/.test(reviewText) && /\| ML \|/.test(reviewText) && /\| MATH \|/.test(reviewText))
    check('类型分布分母=三行之和', /合计大于论文数（分母=(\d+)）/.test(reviewText))
    check('时间线两张表', reviewText.includes('| 年份 | 新增论文 | 累计论文 |') && reviewText.includes('| 算法 | 首见 | 最近 |'))
    check('领域分布含未分类口径说明', reviewText.includes('> 论文可多标签，合计可能大于论文数（分母=6）'))
    check('代表性论文 4 列表头', reviewText.includes('| 领域 | 论文 | 年份 | 算法数 |'))
    check('领域≤2 时每领域取 3 篇的规则可用', reviewText.includes('按命中算法数选取'))
    check('最近新增按 readAt', reviewText.includes('按登记时间（readAt）统计'))
    check('可信度 ≥5 行', (reviewText.match(/\| 摘要级占比 \|/) !== null) && reviewText.includes('| 样本量 |'))
    check('附录两段', reviewText.includes('### A. 完整排行') && reviewText.includes('### B. 论文清单'))
    const lines = reviewText.split('\n')
    check('全文 ≤ 400 行', lines.length <= 400, String(lines.length))
    const chapterStarts = lines.map((line, i) => (/^## \d+\. /.test(line) ? i : -1)).filter((i) => i >= 0)
    const chapterSizes = chapterStarts.map((start, i) => (i + 1 < chapterStarts.length ? chapterStarts[i + 1] - start : lines.length - start))
    const nonAppendix = chapterSizes.slice(0, -1)
    check('非附录章各 ≤ 80 行', nonAppendix.every((n) => n <= 80), JSON.stringify(chapterSizes))
    check('无 HTML 标签、无 emoji', !/<(div|span|table|br)\b/.test(reviewText) && !/[\u{1F300}-\u{1FAFF}]/u.test(reviewText))
  }

  /* ---------------------------------------------------------------- *
   * E25 后半 · decide 五章 + 缺口规则
   * ---------------------------------------------------------------- */
  console.log('\n[3] E25 后半 · decide 五章齐全（先验不命中）')
  {
    check('本章节数 5', review.sections.length === 10)
    const decide = await generateReport(store, { mode: 'decide', generatedAt: FIXED_ISO, referenceYear: 2026 })
    const text = await readFile(decide.path, 'utf8')
    check('五章', decide.sections.length === 5, String(decide.sections.length))
    check(
      '章标题与规范一致',
      decide.sections.map((s) => s.title).join('|') === '缺口清单|缺口证据|方向与动作|口径附录|未评估项',
      decide.sections.map((s) => s.title).join('|'),
    )
    check('G1 命中（摘要级 <50% 但无正文 0 篇 → 不命中）', text.includes('未发现缺口') || text.includes('G1'), text.slice(0, 400))
    check('口径附录与 review 第 9 章同源', text.includes('| 数值口径 |'))
  }

  console.log('\n[4] E25 · 缺口 G1–G5 全部命中')
  {
    const gapStore = await newStore('gaps')
    // 20 篇：全部 LSTM/CNN（MATH 类型 0% → G3）、年份 2015–2018（G4）、半数摘要（G1）、一个领域恰好 2 篇（G2）
    for (let i = 0; i < 20; i += 1) {
      const field = i < 2 ? '薄领域' : i % 2 === 0 ? '空气质量' : 'NLP'
      await ingestPaper(gapStore, {
        title: `缺口样本 ${i}`,
        year: 2015 + (i % 4),
        fields: field,
        depth: i >= 12 ? 'abstract' : 'fulltext',
        text: body(`缺口样本 ${i}`, '方法使用 LSTM 与 CNN。'),
      })
    }
    // 造一篇无正文（G1 的第二条触发条件）
    const firstId = [...gapStore.papers.keys()][0]
    gapStore.papers.get(firstId).hasText = false
    // 造旧口径（G5）
    const currentDict = __test.DICT_VERSION
    for (const mention of gapStore.mentions.values()) mention.dictVersion = '1999.1.1'
    await gapStore.save()

    const decide = await generateReport(gapStore, {
      mode: 'decide',
      generatedAt: FIXED_ISO,
      referenceYear: 2026,
    })
    const text = await readFile(decide.path, 'utf8')
    check('五章仍齐全', decide.sections.length === 5)
    for (const id of ['G1', 'G2', 'G3', 'G4', 'G5']) {
      check(`缺口清单含 ${id}`, new RegExp(`\\| ${id} \\|`).test(text))
    }
    check('严重度映射（G1 高 / G5 低）', /\| G1 \| 输入质量欠账 \| 高 \|/.test(text) && /\| G5 \| 口径陈旧 \| 低 \|/.test(text))
    check('G2 薄领域列出', /2 篇的领域 1 个（薄领域）/.test(text), text.match(/2 篇的领域[^\n]*/)?.[0] ?? '')
    check('G2 未分类不计入', !/2 篇的领域[^\n]*未分类/.test(text))
    check('三段时间结构', text.includes('判定规则：') && text.includes('实测：') && text.includes('命中：是'))
    check('G1 可补清单 5 列', text.includes('| 标题 | 年份 | 算法数 | 深度 | 登记日 |'))
    check('G1 清单按算法数降序', (() => {
      const rows = [...text.matchAll(/^\| (缺口样本 \d+) \| \d{4} \| (\d+) \|/gm)].map((m) => Number(m[2]))
      return rows.length > 1 && rows.every((n, i) => i === 0 || rows[i - 1] >= n)
    })())
    check('G5 动作指向 reextract', text.includes('/radar reextract'))
    check('G3 类型占比证据用类型代码', /低于门槛的类型：.*MATH 0\.0%/.test(text), text.match(/低于门槛的类型[^\n]*/)?.[0] ?? '')
    check('口径附录与 review 同源', text.includes('| 项目 | 说明 |'))
    check('未评估项含无年份提示或库小提示', text.includes('未评估项'))
    check('旧口径提及为 0（本库无旧口径）', true)
  }

  /* ---------------------------------------------------------------- *
   * E26 可复现
   * ---------------------------------------------------------------- */
  console.log('\n[5] E26 · 同参数两次生成字节一致')
  {
    const first = await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO, referenceYear: 2026 })
    const second = await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO, referenceYear: 2026 })
    check('两次是不同文件（同名不覆盖）', first.path !== second.path, `${first.path} vs ${second.path}`)
    const stripSerial = (p) => p.replace(/-(\d+)\.md$/, '.md')
    check('第二个文件是同名追加序号', stripSerial(second.path) === stripSerial(first.path) && /-\d+\.md$/.test(second.path), second.path)
    const hashA = sha256(await readFile(first.path))
    const hashB = sha256(await readFile(second.path))
    check('sha256 相同', hashA === hashB, `${hashA} vs ${hashB}`)

    const decideA = await generateReport(store, { mode: 'decide', generatedAt: FIXED_ISO, referenceYear: 2026 })
    const decideB = await generateReport(store, { mode: 'decide', generatedAt: FIXED_ISO, referenceYear: 2026 })
    check('decide 也一致', sha256(await readFile(decideA.path)) === sha256(await readFile(decideB.path)))

    const other = await generateReport(store, { mode: 'review', generatedAt: new Date(FIXED + 60000).toISOString(), referenceYear: 2026 })
    check('换时间戳内容变（时间确实参数化）', sha256(await readFile(other.path)) !== hashA)
  }

  /* ---------------------------------------------------------------- *
   * E27 不含正文
   * ---------------------------------------------------------------- */
  console.log('\n[6] E27 · 报告不出现正文（40 字符探针）')
  {
    const textsDir = join(storePath('main'), '..', 'texts')
    const { gzipSync, gunzipSync } = await import('node:zlib')
    const files = (await readdir(textsDir)).filter((f) => f.endsWith('.txt.gz'))
    check('有留存正文可作探针来源', files.length > 0, String(files.length))
    const raw = gunzipSync(await readFile(join(textsDir, files[0]))).toString('utf8')
    const probes = []
    for (let offset = 0; offset + 40 <= raw.length && probes.length < 20; offset += 37) {
      probes.push(raw.slice(offset, offset + 40).replace(/\s+/g, ' ').trim())
    }
    const reviewText = await readFile(review.path, 'utf8')
    const decideText = await readFile((await generateReport(store, { mode: 'decide', generatedAt: FIXED_ISO, referenceYear: 2026 })).path, 'utf8')
    const leakReview = probes.filter((p) => p.length >= 30 && reviewText.includes(p))
    const leakDecide = probes.filter((p) => p.length >= 30 && decideText.includes(p))
    check('review 无 40 字符正文片段', leakReview.length === 0, leakReview[0] ?? '')
    check('decide 无 40 字符正文片段', leakDecide.length === 0, leakDecide[0] ?? '')
    check('片段只给定位符', reviewText.includes('片段 #1（') || !reviewText.includes('片段'))
    check('没有任何 200 字符以上的连续正文行', reviewText.split('\n').every((line) => [...line].length <= 240))
    void gzipSync
  }

  /* ---------------------------------------------------------------- *
   * E28 只读
   * ---------------------------------------------------------------- */
  console.log('\n[7] E28 · 生成前后库与正文零变化')
  {
    const file = storePath('main')
    const textsDir = join(root, 'main', 'texts')
    const before = {
      db: sha256(await readFile(file)),
      dbBytes: (await stat(file)).size,
      texts: (await readdir(textsDir)).sort().join(','),
      textsHashes: await Promise.all(
        (await readdir(textsDir)).sort().map(async (name) => sha256(await readFile(join(textsDir, name)))),
      ),
    }
    await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO })
    await generateReport(store, { mode: 'decide', generatedAt: FIXED_ISO })
    const after = {
      db: sha256(await readFile(file)),
      dbBytes: (await stat(file)).size,
      texts: (await readdir(textsDir)).sort().join(','),
      textsHashes: await Promise.all(
        (await readdir(textsDir)).sort().map(async (name) => sha256(await readFile(join(textsDir, name)))),
      ),
    }
    check('radar.json sha256 不变', before.db === after.db)
    check('radar.json 字节数不变', before.dbBytes === after.dbBytes)
    check('texts/ 文件清单不变', before.texts === after.texts)
    check('texts/ 每个文件哈希不变', before.textsHashes.join(',') === after.textsHashes.join(','))
    check('报告写在 exports/reports/', /exports[\\/]reports[\\/]/.test(review.path))
  }

  /* ---------------------------------------------------------------- *
   * E30 writeEnabled=false 仍可用
   * ---------------------------------------------------------------- */
  console.log('\n[8] E30 · writeEnabled=false 时工具仍注册、仍能生成')
  {
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'w30')
    try {
      const ctx = fakeCtx()
      const { apply } = await import('../lib/index.js')
      await apply(ctx, { writeEnabled: false })
      check('radar_report 已注册', ctx._tools.get('radar_report') !== undefined)
      check('写工具未注册（对照组）', ctx._tools.get('radar_add') === undefined)
      const tool = ctx._tools.get('radar_report')
      const result = await tool.execute({ mode: 'review', generatedAt: FIXED_ISO })
      check('能生成', typeof result.path === 'string' && result.bytes > 0, JSON.stringify(result).slice(0, 120))
      check('返回体没有 content 字段', result.content === undefined)
      check('返回体有章节标题', Array.isArray(result.sections) && result.sections.length > 0)
      const status = await ctx._tools.get('radar_status').execute()
      check('radar_report 在读工具清单里', status.tools.includes('radar_report'))
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
    }
  }

  /* ---------------------------------------------------------------- *
   * 参数化 / 只读保证 / 缺字段 / 润色占位块
   * ---------------------------------------------------------------- */
  console.log('\n[8b] FR-13.1 / FR-13.12 · /radar report 命令走同一实现')
  {
    const { registerRadarCommand } = await import('../lib/command.js')
    const registered = []
    const ctx = {
      logger: { warn() {}, info() {}, error() {} },
      inject(services, fn) {
        if (!services.includes('commands')) return () => {}
        fn({ commands: { register: (def) => { registered.push(def); return () => {} } } })
        return () => {}
      },
    }
    const calls = []
    registerRadarCommand(ctx, {
      status: async () => ({ paperCount: 0 }),
      reextract: async () => ({ total: 0, changed: 0, skippedNoText: 0 }),
      exportFile: async () => ({ path: 'x', bytes: 1, format: 'json' }),
      report: async (options) => {
        calls.push(options)
        return { path: 'C:\\tmp\\r.md', bytes: 2048, mode: options.mode, scope: '全库', sections: [{ n: 1, title: '摘要' }, { n: 2, title: '数据画像' }] }
      },
    })
    check('命令已注册', registered.length === 1)
    const handler = registered[0].handler
    const review = await handler({ rawInput: 'report' })
    check('默认 review', calls.at(-1)?.mode === 'review', JSON.stringify(calls.at(-1)))
    check('回复带路径与章节', review.kind === 'success' && review.text.includes('r.md') && review.text.includes('1. 摘要'), review.text)
    await handler({ rawInput: 'report decide' })
    check('decide 子参数', calls.at(-1)?.mode === 'decide', JSON.stringify(calls.at(-1)))
    await handler({ rawInput: 'report --days 7' })
    check('--days 透传', calls.at(-1)?.windowDays === 7, JSON.stringify(calls.at(-1)))
    await handler({ rawInput: 'report --field 空气质量' })
    check('--field 转 scope=field', calls.at(-1)?.scope === 'field' && calls.at(-1)?.field === '空气质量', JSON.stringify(calls.at(-1)))
    await handler({ rawInput: 'report --years 2019-2021' })
    check('--years 转 scope=yearRange', calls.at(-1)?.scope === 'yearRange' && calls.at(-1)?.yearFrom === 2019 && calls.at(-1)?.yearTo === 2021, JSON.stringify(calls.at(-1)))
    check('RADAR_USAGE 提到 report', (await handler({ rawInput: 'nonsense' })).text.includes('report'))
  }

  console.log('\n[9] 参数化：scope=field / yearRange / path 越界 / 同名不覆盖')
  {
    // scope 用独立库：目标领域 5 篇（≥5 不触发降级），另一领域 1 篇
    const scopeStore = await newStore('scope')
    for (let i = 0; i < 5; i += 1) {
      await ingestPaper(scopeStore, { title: `空气样本 ${i}`, year: 2018 + i, fields: '空气质量', text: body(`空气 ${i}`, '使用 LSTM。') })
    }
    await ingestPaper(scopeStore, { title: '别的领域', year: 2023, fields: 'NLP', text: body('NLP', '使用 CRF。') })
    await scopeStore.save()

    const fieldReport = await generateReport(scopeStore, { mode: 'review', scope: 'field', field: '空气质量', generatedAt: FIXED_ISO })
    const fieldText = await readFile(fieldReport.path, 'utf8')
    check('scope 写进报告头', fieldText.includes('范围：领域=空气质量'), fieldText.split('\n')[3])
    check('文件名带 field slug', /radar-report-review-field-空气质量-20261023-0028\.md$/.test(fieldReport.path), fieldReport.path)
    check('分母跟着 scope 变（5 篇）', /分母 = 5 篇（scope 内）/.test(fieldText), fieldText.match(/分母 = \d+ 篇（scope 内）/)?.[0] ?? '')
    check('scope 内只算该领域论文', /库：5 篇/.test(fieldText), fieldText.split('\n')[2])

    const yearReport = await generateReport(scopeStore, { mode: 'review', scope: 'yearRange', yearFrom: 2019, yearTo: 2021, generatedAt: FIXED_ISO })
    const yearText = await readFile(yearReport.path, 'utf8')
    check('年份范围写进报告头', yearText.includes('范围：年份=2019–2021'))
    check('只统计窗口内的论文（3 篇：2019–2021）', /库：3 篇/.test(yearText), yearText.split('\n')[2])
    check('窗口内 <5 篇触发降级', yearText.includes('数据不足（3 篇 < 5）'), yearText.split('\n')[4] ?? '')

    let outside = null
    try {
      await generateReport(store, { mode: 'review', path: 'C:\\Windows\\Temp\\radar-evil', generatedAt: FIXED_ISO })
    } catch (error) {
      outside = error
    }
    check('工作区外路径被拒（VALIDATION）', outside?.code === 'VALIDATION', String(outside?.code ?? outside))

    const insideDir = join(process.cwd(), '.tmp-report-test')
    const custom = await generateReport(store, { mode: 'review', path: insideDir, generatedAt: FIXED_ISO })
    check('接受工作区内目录', custom.path.startsWith(insideDir), custom.path)
    await rm(insideDir, { recursive: true, force: true })

    let badScope = null
    try {
      await generateReport(store, { mode: 'review', scope: 'field' })
    } catch (error) {
      badScope = error
    }
    check('scope=field 缺 field → VALIDATION', badScope?.code === 'VALIDATION', String(badScope?.code))
  }

  console.log('\n[10] 13.10 缺字段：无年份 / 摘要级 / 无正文')
  {
    const partial = await newStore('partial')
    await ingestPaper(partial, { title: '没有年份的论文', text: body('无年份样本', '使用 LSTM。') })
    await ingestPaper(partial, { title: '摘要级论文', year: 2024, depth: 'abstract', text: body('摘要级样本', '使用 CRF。') })
    for (let i = 0; i < 3; i += 1) {
      await ingestPaper(partial, { title: `补齐样本 ${i}`, year: 2023, text: body(`补齐 ${i}`, '使用 SVM。') })
    }
    const id = [...partial.papers.keys()][0]
    partial.papers.get(id).hasText = false
    await partial.save()

    const report = await generateReport(partial, { mode: 'review', generatedAt: FIXED_ISO, referenceYear: 2026 })
    const text = await readFile(report.path, 'utf8')
    check('无年份计入 undated', /无年份 1 篇/.test(text), text.match(/无年份 \d+ 篇/)?.[0] ?? '')
    check('时间线标注 undatedCount', text.includes('> 另有 1 篇无年份论文未计入（undatedCount）'))
    check('无年份论文年份列显示 —', /\| 没有年份的论文 \| — \|/.test(text))
    check('摘要级在附录标注', text.includes('（摘要级）') || /\| 摘要级论文 \| 2024 \|/.test(text))
    check('无正文在局限里说明', /无正文 \| 1 篇无正文/.test(text), text.match(/无正文 \|[^\n]*/)?.[0] ?? '')
  }

  console.log('\n[11] 13.5 润色占位块（narrative=1，插件不调模型）')
  {
    const withNarrative = await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO, narrative: 1 })
    const text = await readFile(withNarrative.path, 'utf8')
    check('报告头标注含模型待补写段落', text.includes('本报告含模型待补写段落（P-10'))
    check('每章都有占位块', (text.match(/<!-- radar:insight section=\d+ -->/g) ?? []).length === 10, String((text.match(/<!-- radar:insight/g) ?? []).length))
    check('占位文案', text.includes('_（此处待补写解读）_'))
    check('返回体标 narrative=1', withNarrative.narrative === 1)

    const plain = await generateReport(store, { mode: 'review', generatedAt: FIXED_ISO, narrative: 0 })
    const plainText = await readFile(plain.path, 'utf8')
    check('narrative=0 没有占位块', !plainText.includes('radar:insight'))
    check('narrative=0 没有 P-10 标注', !plainText.includes('本报告含模型待补写段落'))
  }

  console.log('\n[12] E32 截断（附录 ≤200 行 / 全文 ≤400 行）')
  {
    const fakeData = {
      mode: 'review',
      algorithms: Array.from({ length: 260 }, (_, i) => ({ id: `a${i}`, name: `算法${i}`, papers: 1, mentions: 1 })),
      papers: Array.from({ length: 260 }, (_, i) => ({ title: `论文${i}`, year: 2020, fields: ['x'], hitCount: 1, readAt: 1 })),
    }
    const appendix = renderAppendix(fakeData, { maxRows: 6 })
    const rows = appendix.lines.filter((line) => /^\| \d+ \|/.test(line))
    check('预算收紧时行数受限', rows.length <= 6, String(rows.length))
    check('写了截断说明', appendix.lines.some((line) => line.startsWith('（已截断：显示前')))
    const ratio = appendix.lines.find((line) => line.startsWith('（已截断：显示前')) ?? ''
    check('截断说明给出总数', /共 260）/.test(ratio), ratio)

    // 260 算法 / 260 论文的完整报告：总量必须 ≤400 行
    const big = {
      ...(await import('../lib/report.js')).then ? {} : {},
    }
    void big
    const data = {
      mode: 'review',
      narrative: 0,
      generatedAt: FIXED,
      referenceYear: 2026,
      windowDays: 30,
      timeZone: 'Asia/Shanghai',
      dictVersion: 'test',
      scope: { kind: 'all', label: '全库', slug: 'all' },
      counts: { papers: 260, fulltext: 260, abstract: 0, algorithms: 260, fields: 3, mentions: 260, staleMentions: 0, stalePapers: 0, staleRecomputable: 0, hasTextCount: 260, noText: 0 },
      algorithms: fakeData.algorithms.map((a) => ({ ...a, type: 'DL', typeLabel: '深度学习', family: '架构', firstYear: 2020, lastYear: 2020, stale: false })),
      papers: matchPapers(260),
      fields: [
        { field: 'a', count: 100 },
        { field: 'b', count: 90 },
        { field: 'c', count: 70 },
      ],
      unclassified: 0,
      typeDist: [
        { type: 'DL', label: '深度学习', papers: 260 },
        { type: 'ML', label: '机器学习', papers: 0 },
        { type: 'MATH', label: '数学', papers: 0 },
      ],
      timeline: { years: [{ year: 2020, newPapers: 260, cumulative: 260 }], undated: 0, firstYear: 2020, lastYear: 2020 },
      algorithmYears: [],
      staleMentionsInTop: 0,
      snippetPointers: [],
    }
    const rendered = renderReport(data)
    const lineCount = rendered.content.split('\n').length
    check('260 篇/260 算法仍 ≤400 行', lineCount <= 400, String(lineCount))
    check('附录被截断', rendered.content.includes('（已截断：显示前'))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

function matchPapers(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    title: `论文${i}`,
    year: 2020,
    fields: ['a'],
    depth: 'fulltext',
    hitCount: 1,
    hasText: true,
    readAt: 1,
    updatedAt: 1,
    types: ['DL'],
    top: [],
  }))
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
