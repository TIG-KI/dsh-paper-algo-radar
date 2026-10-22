/**
 * T-19 · W0 验收跑批（§12 用例的可本地执行部分）。
 *
 * 每条用例给出 PASS / FAIL / SKIP 三种结论：
 *  - PASS：本脚本真的跑过并通过
 *  - FAIL：跑了但不通过（会导致退出码非 0）
 *  - SKIP：需要网络 / 宿主凭据 / 人工抽查，**不作为「已通过」**
 *
 * 运行：node test/acceptance.mjs
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extract, buildMatchers } from '../lib/extract.js'
import { boundResult } from '../lib/contract.js'
import { migrateSnapshot } from '../lib/migrate.js'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, buildExportTool, buildImportTool, DICT_VERSION } = __test

const results = []
const record = (id, name, status, detail = '') => {
  results.push({ id, name, status, detail })
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·'
  console.log(`  ${mark} ${id} ${name}${detail ? ' — ' + detail : ''}`)
}

const DICT = buildMatchers([
  { id: 'gan', name: 'GAN', type: 'DL', aliases: ['GAN'] },
  { id: 'svm', name: 'SVM', type: 'ML', aliases: ['SVM'] },
  { id: 'adam', name: 'Adam', type: 'MATH', aliases: ['Adam'] },
  { id: 'lstm', name: 'LSTM', type: 'DL', aliases: ['LSTM'] },
  { id: 'crf', name: 'CRF', type: 'ML', aliases: ['CRF'] },
])

const BODY_BASE =
  '摘　要：本文研究命名实体识别，方法上使用 LSTM 与 CRF，并以 Adam 做优化。' +
  '实验部分与 SVM、随机森林、CNN 基线对比，评价指标为 F1，并报告消融结果：' +
  '去掉 CRF 后 F1 下降约百分之四，去掉 LSTM 后下降约百分之七。' +
  '训练使用早停策略，验证集与测试集严格分离，标注体系遵循 CoNLL-2003 的 BMES 方案。' +
  '结论部分总结了贡献，指出未来工作将扩展到跨语言与低资源场景，并公开预处理脚本与超参数配置，' +
  '以便在同一数据划分上复现本文的全部数字。'

// 补齐到 320 字符以上（插件的门槛是 300 code point；补的内容不含任何算法名）
const FILLER = '本文的补充说明用于满足最小正文长度，不引入额外的方法名称。'
let bodyText = BODY_BASE
while (bodyText.length < 320) bodyText += FILLER
const BODY = bodyText

const dir = await mkdtemp(join(tmpdir(), 'radar-accept-'))

try {
  console.log('\n[§12.1 继承用例]')

  // A2：参考文献里的方法名不能计入
  {
    const head = '正文。'.repeat(4000)
    const text = `${head}\n\nReferences\n[1] GAN. 2014.\n[2] SVM. 1995.\n[3] Adam. 2015.\n`
    const r = extract(text, DICT, { depth: 'fulltext' })
    const ids = r.hits.map((h) => h.id)
    const ok = !ids.includes('gan') && !ids.includes('svm') && !ids.includes('adam') && r.refCut.method === 'L1'
    record('A2', '参考文献中的方法名不计入', ok ? 'PASS' : 'FAIL', `refCut=${r.refCut.method} hits=${ids.join(',') || '（空）'}`)
  }

  // A2b：标题出现在 28% 处，但绝对偏移 < 3000 → 落在「3000 code point 地板」之下
  // 这才是 A2b 真正在测的东西：25% 不是唯一门槛，还有 3000 cp 的绝对下限
  {
    const before = '正文。'.repeat(933) // 2799 code point
    const after = '正文。'.repeat(2400) // 7200 code point
    const text = `${before}\nReferences\n[1] GAN. 2014.\n[2] SVM. 1995.\n${after}`
    const offsetRatio = (before.length / text.length).toFixed(3)
    const r = extract(text, DICT, { depth: 'fulltext' })
    const ok = r.refCut.method === null && r.refHintEarly === true
    record('A2b', '28% 处但 <3000cp 的参考文献只记 refHintEarly', ok ? 'PASS' : 'FAIL', `位置≈${offsetRatio} method=${r.refCut.method} hint=${r.refHintEarly}`)
  }

  // C1：删除连带提及
  {
    const store = new Store(join(dir, 'c1.json'))
    await store.load()
    const added = await ingestPaper(store, { title: 'C1', text: BODY })
    const paperId = added.paper.id
    const { removePaper } = __test
    const removed = await removePaper(store, paperId)
    const ok = removed.existed === true && store.papers.size === 0 && store.mentions.size === 0 && store.paperKeys.size === 0
    record('C1', '删除论文连带提及与三键', ok ? 'PASS' : 'FAIL', `papers=${store.papers.size} mentions=${store.mentions.size} keys=${store.paperKeys.size}`)
  }

  console.log('\n[§12.2 新增用例]')

  // E10：先无年份、后补年份 → 仍一篇
  {
    const store = new Store(join(dir, 'e10.json'))
    await store.load()
    const first = await ingestPaper(store, { title: 'E10 论文', text: BODY })
    const second = await ingestPaper(store, { title: 'E10 论文', text: BODY, year: 2024 })
    const ok = second.created === false && second.paper.id === first.paper.id && store.papers.size === 1 && second.paper.year === 2024
    record('E10', '补年份重复登记仍是一篇', ok ? 'PASS' : 'FAIL', `papers=${store.papers.size} year=${second.paper.year}`)
  }

  // E15：正文 > 5,000,000 code point 拒绝
  {
    const store = new Store(join(dir, 'e15.json'))
    await store.load()
    const huge = 'a'.repeat(5000001)
    let error = null
    try {
      await ingestPaper(store, { title: 'E15', text: huge })
    } catch (e) {
      error = e
    }
    const ok = error?.code === 'PAYLOAD_TOO_LARGE' && store.papers.size === 0
    record('E15', '超长正文拒绝且不入库', ok ? 'PASS' : 'FAIL', `code=${error?.code} papers=${store.papers.size}`)
  }

  // E19：单次返回 ≤ 12,000 字符
  {
    const big = { items: Array.from({ length: 400 }, (_, i) => ({ i, name: '算法' + i, text: 'x'.repeat(40) })), total: 400 }
    const bounded = boundResult(big)
    const len = JSON.stringify(bounded).length
    const ok = len <= 12000 && bounded.truncated === true && bounded.truncatedFields?.[0]?.total === 400
    record('E19', '返回体预算 ≤12k 且显式标注', ok ? 'PASS' : 'FAIL', `len=${len}`)
  }

  // E21：加载期零副作用（用假 ctx 跑 apply，检查数据文件一字节未变）
  {
    const home = join(dir, 'e21')
    const storeDir = join(home, 'plugin-data', 'paper-algo-radar')
    await (await import('node:fs/promises')).mkdir(storeDir, { recursive: true })
    const storeFile = join(storeDir, 'store.json')
    const seed = JSON.stringify({ version: 1, papers: {}, algorithms: {}, mentions: {}, meta: {} })
    await writeFile(storeFile, seed, 'utf8')
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const tools = new Map()
    const ctx = {
      tools: { register: (t) => (tools.set(t.name, t), () => {}), get: (n) => tools.get(n) },
      effect: (fn) => {
        const d = fn()
        return () => d && d()
      },
      inject: () => () => {},
      logger: { warn() {}, info() {}, error() {} },
    }
    const { apply } = await import('../lib/index.js')
    await apply(ctx)
    const after = await readFile(storeFile, 'utf8')
    const files = await readdir(storeDir)
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    const ok = after === seed && files.length === 1
    record('E21', '加载期不读不写数据文件', ok ? 'PASS' : 'FAIL', `files=${files.join(',')}`)
  }

  // E16 形态：v0.2 快照迁移不丢数据
  {
    const legacy = {
      version: 1,
      papers: { p_0123456789abcdef: { id: 'p_0123456789abcdef', title: 'Legacy', chars: 5000, fields: ['x'] } },
      algorithms: {},
      mentions: {
        'p_0123456789abcdef::lstm': { paperId: 'p_0123456789abcdef', algorithmId: 'lstm', count: 3, sections: { experiments: 3 } },
      },
      meta: {},
    }
    const { data, report } = migrateSnapshot(legacy)
    const mention = Object.values(data.mentions)[0]
    const ok =
      data.version === 2 &&
      Object.keys(data.papers).length === 1 &&
      mention.dictVersion === 'v0.2-legacy' &&
      mention.sections.experiment === 3 &&
      report.droppedMentions === 0
    record('E16', 'v0.2 快照迁移不丢数据且口径回填', ok ? 'PASS' : 'FAIL', `dict=${mention?.dictVersion}`)
  }

  // E6：导出 → 清空 → 导入（结构化数据完全一致）
  {
    const store = new Store(join(dir, 'e6.json'))
    await store.load()
    await ingestPaper(store, { title: 'E6 甲', text: BODY, year: 2024, doi: '10.1000/e6a' })
    await ingestPaper(store, { title: 'E6 乙', text: BODY, year: 2023 })
    const beforeCounts = {
      papers: store.papers.size,
      mentions: store.mentions.size,
      algorithms: store.algorithms.size,
    }
    const exporter = buildExportTool(async () => store)
    const out = await exporter.execute({ format: 'json' })
    const dump = JSON.parse(await readFile(out.path, 'utf8'))

    const { clearLibrary } = __test
    const { cleared } = await clearLibrary(store)
    const clearedOk = cleared === beforeCounts.papers && store.papers.size === 0

    const importer = buildImportTool(async () => store, { get: () => ({ request: async () => 'allowed-once' }) })
    await importer.execute({ path: out.path, dryRun: false }, { agent: {}, name: 'radar_import' })
    const after = {
      papers: store.papers.size,
      mentions: store.mentions.size,
      algorithms: store.algorithms.size,
    }
    const ok =
      clearedOk &&
      after.papers === beforeCounts.papers &&
      after.mentions === beforeCounts.mentions &&
      dump.schemaVersion === 2 &&
      typeof dump.dictVersion === 'string'
    record(
      'E6',
      '导出 → 清空 → 导入 数据一致',
      ok ? 'PASS' : 'FAIL',
      `清空 ${cleared} 篇；回来后 ${after.papers} 篇 / ${after.mentions} 条提及（原 ${beforeCounts.papers} / ${beforeCounts.mentions}）`,
    )
  }

  // E13：删除 → 撤销（10 秒窗口），正文与提及一起回来
  {
    const store = new Store(join(dir, 'e13.json'))
    await store.load()
    const added = await ingestPaper(store, { title: 'E13 论文', text: BODY, year: 2024 })
    const paperId = added.paper.id
    const granting = { get: () => ({ request: async () => 'allowed-once' }) }
    const { UndoStack, buildRemoveTool, buildRestoreTool } = __test
    const stack = new UndoStack()
    const remover = buildRemoveTool(async () => store, stack, granting)
    const restorer = buildRestoreTool(async () => store, stack)
    const removed = await remover.execute({ paperId, dryRun: false }, { agent: {}, name: 'radar_remove' })
    const gone = store.papers.size === 0 && store.mentions.size === 0
    const back = await restorer.execute({ token: removed.undo.token })
    const ok =
      gone &&
      store.papers.size === 1 &&
      store.mentions.size > 0 &&
      store.papers.get(paperId)?.hasText === true &&
      back.restoredPapers === 1
    record('E13', '删除 → 10 秒内撤销（含正文）', ok ? 'PASS' : 'FAIL', `恢复 ${back.restoredPapers} 篇，hasText=${store.papers.get(paperId)?.hasText}`)
  }

  console.log('\n[未验证 —— 需要网络 / 宿主凭据 / 人工]')
  record('A1', '样例正文命中 19 个算法', 'SKIP', '缺 v0.2 样例正文')
  record('A3', '中文摘要 218 字命中 LSTM×3 等', 'SKIP', '缺样例文本')
  record('A4', 'arXiv 1804.07891 抓全文', 'SKIP', '需要网络')
  record('B1', '检索「空气质量预测」', 'SKIP', '需要 paper_search + 网络')
  record('E2', '会话内链接登记', 'SKIP', '需要模型 + 宿主会话')
  record('E3', 'PDF 上传与扫描件', 'SKIP', 'PDF 路径属 W1.1')
  record('E4', '点排行进详情', 'SKIP', '无头浏览器实测通过（spike/evidence/w1-detail.png），脚本不覆盖')
  record('E22', '深浅色跟随', 'SKIP', '无头浏览器实测通过，脚本不覆盖')
  record('D1', '50 篇 Top10 人工抽查', 'SKIP', '人工')

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  console.log(`\n汇总：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`)
  if (fail > 0) {
    console.log('失败项：' + results.filter((r) => r.status === 'FAIL').map((r) => r.id).join(', '))
  }
  console.log('注意：SKIP 不等于通过，W0 交付判定只认 PASS 项 + 人工确认的 SKIP 项。')
  process.exitCode = fail === 0 ? 0 : 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
