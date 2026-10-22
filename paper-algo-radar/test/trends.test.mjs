/**
 * W1.1 验收：趋势（`radar_trends`）+ 领域分布（`radar_fields`）+ 面板筛选所需的分面数据。
 *
 * 运行：node test/trends.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, buildTrendsTool, buildFieldsTool, buildTrends, buildFields, buildState, DICT_VERSION } = __test

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
const body = (topic) => {
  let text = `摘　要：本文研究${topic}。方法上使用 LSTM 与 CRF，并以 Adam 优化，实验中与 SVM 对比。`
  while (text.length < 340) text += FILLER
  return text
}

const dir = await mkdtemp(join(tmpdir(), 'radar-trends-'))
const store = new Store(join(dir, 'store.json'))
await store.load()

try {
  // 2020：LSTM + SVM；2022：LSTM；无年份：LSTM
  await ingestPaper(store, { title: '甲', text: body('命名实体识别'), year: 2020, fields: 'NLP, 时序预测' })
  await ingestPaper(store, { title: '乙', text: body('时序预测'), year: 2022, fields: '时序预测' })
  await ingestPaper(store, { title: '丙', text: body('图学习'), fields: '' })

  const trendsTool = buildTrendsTool(async () => store)
  const fieldsTool = buildFieldsTool(async () => store)

  console.log('\n[1] 趋势：默认取前 N 个')
  const trends = await trendsTool.execute({})
  check('有序列', Array.isArray(trends.series) && trends.series.length > 0, String(trends.series?.length))
  check('默认最多 5 个', trends.series.length <= 5, String(trends.series.length))
  const lstm = trends.series.find((s) => s.id === 'lstm')
  check('LSTM 在序列里', lstm !== undefined)
  check('LSTM 有两年数据', lstm.points.length === 2, JSON.stringify(lstm.points))
  check('年份升序', lstm.points[0].year === 2020 && lstm.points[1].year === 2022, JSON.stringify(lstm.points))
  check('papers 是论文数（不是提及数）', lstm.points.every((p) => p.papers === 1), JSON.stringify(lstm.points))
  check('回报无年份篇数', trends.undatedCount === 1, String(trends.undatedCount))
  check('带年份范围', trends.yearMin === 2020 && trends.yearMax === 2022, `${trends.yearMin}-${trends.yearMax}`)

  console.log('\n[2] 趋势：指定 ids 与年份区间')
  const only = await trendsTool.execute({ ids: ['lstm'], from: 2021, to: 2023 })
  check('只返回指定算法', only.series.length === 1 && only.series[0].id === 'lstm')
  check('区间内只剩 2022', only.series[0].points.length === 1 && only.series[0].points[0].year === 2022, JSON.stringify(only.series[0].points))
  check('from/to 回显', only.from === 2021 && only.to === 2023)

  const unknown = await trendsTool.execute({ ids: ['not-an-algorithm'] })
  check('未知 id 也给空点集而不是崩', unknown.series.length === 1 && unknown.series[0].points.length === 0)

  console.log('\n[3] 趋势卡片')
  const trendCard = trendCard0(trendsTool, trends)
  check('卡片列出年份×篇数', trendCard.includes('2020×1'), trendCard)
  check('卡片提到无年份', trendCard.includes('无年份'), trendCard)

  console.log('\n[4] 领域分布')
  const fields = await fieldsTool.execute()
  check('时序预测 2 篇', fields.fields.find((f) => f.name === '时序预测')?.count === 2, JSON.stringify(fields.fields))
  check('NLP 1 篇', fields.fields.find((f) => f.name === 'NLP')?.count === 1)
  check('按篇数降序', fields.fields[0].count >= fields.fields[fields.fields.length - 1].count)
  check('未分类 1 篇', fields.unclassified === 1, String(fields.unclassified))
  check('total 与库一致', fields.total === 3, String(fields.total))

  console.log('\n[5] 面板筛选所需的分面（FR-3.4 / FR-3.8）')
  // paperLimit 必须给足：传 0 会被当成「取 0 条」，不是「不限制」
  const state = buildState(store, { paperLimit: Number.MAX_SAFE_INTEGER })
  const paperA = state.papers.find((p) => p.title === '甲')
  check('论文带 types', Array.isArray(paperA.types) && paperA.types.length > 0, JSON.stringify(paperA.types))
  check('论文带 stale 标记', typeof paperA.stale === 'boolean', String(paperA.stale))
  check('新登记的论文不是旧口径', paperA.stale === false)
  check('算法行仍带 stale', typeof state.algorithms[0].stale === 'boolean')

  // 把一条提及降级，验证论文级 stale 会跟着变
  for (const [key, mention] of store.mentions) {
    if (mention.paperId === paperA.id) {
      store.mentions.set(key, { ...mention, dictVersion: 'v0.2-legacy' })
      break
    }
  }
  const state2 = buildState(store, { paperLimit: Number.MAX_SAFE_INTEGER })
  check('降级后论文标 stale', state2.papers.find((p) => p.id === paperA.id)?.stale === true)

  console.log('\n[6] 空库')
  const emptyStore = new Store(join(dir, 'empty.json'))
  await emptyStore.load()
  const emptyTrends = buildTrends(emptyStore, {})
  check('空库趋势为空', emptyTrends.series.length === 0)
  check('空库 undatedCount=0', emptyTrends.undatedCount === 0)
  const emptyFields = buildFields(emptyStore)
  check('空库领域为空', emptyFields.fields.length === 0 && emptyFields.total === 0)
  check('空库卡片不抛', Array.isArray(buildTrendsTool(async () => emptyStore).output.render({}, emptyTrends)))
} finally {
  await rm(dir, { recursive: true, force: true })
}

function trendCard0(tool, value) {
  return tool.output.render({}, value).map((b) => b.text).join('\n')
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
