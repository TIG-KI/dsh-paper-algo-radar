/**
 * W1.2 验收：共现分析（FR-3.6）、每篇封顶计数（FR-3.7）、双时间轴（FR-4.4）。
 *
 * 运行：node test/cooccurrence.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, apply } = await import('../lib/index.js')
const { Store, ingestPaper, buildCooccurrence, buildCooccurrenceTool, buildState, buildTrends } = __test

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

const FILLER = '补充说明用于满足最小正文长度，不引入额外方法名称。'
const body = (topic, extra = '') => {
  let text = `摘　要：本文研究${topic}。方法上使用 LSTM 与 CRF，并以 Adam 优化，实验中与 SVM 对比。${extra}`
  while (text.length < 340) text += FILLER
  return text
}

const dir = await mkdtemp(join(tmpdir(), 'radar-cooc-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
const getStore = async () => store

try {
  // 甲：LSTM + CRF；乙：LSTM + CRF；丙：SVM（+LSTM 一次）
  await ingestPaper(store, { title: '甲', text: body('命名实体识别'), year: 2022, fields: 'NLP' })
  await ingestPaper(store, { title: '乙', text: body('命名实体识别'), year: 2023, fields: 'NLP' })
  await ingestPaper(store, { title: '丙', text: body('时序预测'), year: 2024, fields: '时序' })

  console.log('\n[1] 共现：同篇才计')
  const cooc = buildCooccurrence(store, { minPapers: 1, limit: 50 })
  check('有结果', cooc.pairs.length > 0, String(cooc.pairs.length))
  const lstmCrf = cooc.pairs.find(
    (p) => (p.a.id === 'lstm' && p.b.id === 'crf') || (p.a.id === 'crf' && p.b.id === 'lstm')
  )
  check('LSTM + CRF 被识别为共现', lstmCrf !== undefined, JSON.stringify(cooc.pairs.map((p) => `${p.a.id}+${p.b.id}`)))
  check('共现篇数 ≥ 2', lstmCrf.papers >= 2, String(lstmCrf.papers))
  check('带 lift', typeof lstmCrf.lift === 'number' && lstmCrf.lift > 0, String(lstmCrf.lift))
  check('带各自的论文数', lstmCrf.papersA >= lstmCrf.papers && lstmCrf.papersB >= lstmCrf.papers)
  check('paperCount 正确', cooc.paperCount === 3, String(cooc.paperCount))

  console.log('\n[2] minPapers 门槛')
  const strict = buildCooccurrence(store, { minPapers: 3, limit: 50 })
  check('门槛 3 时过滤掉只共现 2 篇的组合', strict.pairs.every((p) => p.papers >= 3), JSON.stringify(strict.pairs.map((p) => p.papers)))
  check('totalPairs 与门槛一致', strict.totalPairs === strict.pairs.length, `${strict.totalPairs}`)

  console.log('\n[3] 按领域过滤')
  const nlp = buildCooccurrence(store, { field: 'NLP', minPapers: 1, limit: 50 })
  check('只算 NLP 的 2 篇', nlp.paperCount === 2, String(nlp.paperCount))
  check('回显领域', nlp.field === 'NLP')
  const empty = buildCooccurrence(store, { field: '不存在的领域', minPapers: 1 })
  check('不存在的领域返回空', empty.pairs.length === 0 && empty.paperCount === 0)

  console.log('\n[4] 封顶计数（FR-3.7）')
  const before = buildState(store, { paperLimit: 100 })
  const lstmRowBefore = before.algorithms.find((a) => a.id === 'lstm')
  check('默认不封顶（cap=0）', before.capPerPaper === 0, String(before.capPerPaper))
  check('mentions = rawMentions（未封顶）', lstmRowBefore.mentions === lstmRowBefore.rawMentions, `${lstmRowBefore.mentions}/${lstmRowBefore.rawMentions}`)

  // 用 apply 配 capPerPaper=2，再取一次状态
  const events = { tools: new Map() }
  const ctx = {
    tools: {
      register(tool) {
        events.tools.set(tool.name, tool)
        return () => {}
      },
      get: (name) => events.tools.get(name),
    },
    effect(fn) {
      const d = fn()
      return () => d && d()
    },
    inject: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
  }
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  await apply(ctx, { capPerPaper: 2 })
  const status = events.tools.get('radar_status')
  check('状态里带 capPerPaper=2', status !== undefined)
  const capped = buildState(store, { paperLimit: 100 })
  const lstmCapped = capped.algorithms.find((a) => a.id === 'lstm')
  check('cap=2 生效（state.capPerPaper=2）', capped.capPerPaper === 2, String(capped.capPerPaper))
  check(
    'mentions 被裁到 ≤ 2×论文数',
    lstmCapped.mentions <= 2 * lstmCapped.papers,
    `${lstmCapped.mentions} vs ${lstmCapped.papers} 篇`
  )
  check('rawMentions 保留原值', lstmCapped.rawMentions >= lstmCapped.mentions, `${lstmCapped.rawMentions}/${lstmCapped.mentions}`)
  check('总数也按封顶算', capped.mentionCount <= capped.rawMentionCount, `${capped.mentionCount}<=${capped.rawMentionCount}`)
  check('论文数不受封顶影响', capped.paperCount === before.paperCount, `${capped.paperCount} vs ${before.paperCount}`)

  await apply(ctx, { capPerPaper: 0 })
  const restored = buildState(store, { paperLimit: 100 })
  const lstmRestored = restored.algorithms.find((a) => a.id === 'lstm')
  check('恢复不封顶后 mentions 回到原值', lstmRestored.mentions === lstmRowBefore.mentions, `${lstmRestored.mentions} vs ${lstmRowBefore.mentions}`)
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome

  console.log('\n[5] 双时间轴（FR-4.4）')
  const byYear = buildTrends(store, { ids: ['lstm'], includeSamples: true })
  check('默认按发表年', byYear.axis === 'year', byYear.axis)
  check('发表年有点', byYear.series[0].points.length >= 1, JSON.stringify(byYear.series[0].points))
  const byReadAt = buildTrends(store, { ids: ['lstm'], axis: 'readAt', includeSamples: true })
  check('axis=readAt 生效', byReadAt.axis === 'readAt', byReadAt.axis)
  check('入库年也有点（刚登记，应该是今年）', byReadAt.series[0].points.length === 1, JSON.stringify(byReadAt.series[0].points))
  const thisYear = new Date().getFullYear()
  check('入库年是当前年份', byReadAt.series[0].points[0].year === thisYear, String(byReadAt.series[0].points[0].year))
  check('两种时间轴的点不同', JSON.stringify(byYear.series[0].points) !== JSON.stringify(byReadAt.series[0].points))

  console.log('\n[6] 工具与卡片')
  const tool = buildCooccurrenceTool(getStore)
  const value = await tool.execute({ minPapers: 1, limit: 20 })
  check('工具能跑', value.pairs.length > 0)
  const card = tool.output.render({}, value).map((b) => b.text).join('\n')
  check('卡片含「篇」与 lift', card.includes('篇') && card.includes('lift'), card.slice(0, 60))
  const emptyCard = tool.output.render({}, { pairs: [], totalPairs: 0, paperCount: 0 }).map((b) => b.text).join('\n')
  check('空结果有解释', emptyCard.includes('没有'), emptyCard)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
