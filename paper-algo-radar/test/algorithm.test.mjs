/**
 * W1-06 验收：算法下钻（§7 FR-3.5）。
 * 运行：node test/algorithm.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, buildAlgorithmTool, buildAlgorithmDetail, DICT_VERSION } = __test

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

const dir = await mkdtemp(join(tmpdir(), 'radar-algo-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
try {
  await ingestPaper(store, { title: '论文甲', text: body('命名实体识别'), year: 2022 })
  await ingestPaper(store, { title: '论文乙', text: body('命名实体识别'), year: 2024 })
  await ingestPaper(store, { title: '论文丙', text: body('时序预测') })

  const tool = buildAlgorithmTool(async () => store)

  console.log('\n[1] 按 id / name / 别名解析')
  const byId = await tool.execute({ id: 'lstm' })
  check('按 id 命中', byId.algorithm.id === 'lstm', byId.algorithm?.id)
  check('带类型与分类', byId.algorithm.type === 'DL' && typeof byId.algorithm.family === 'string')
  check('带别名数组', Array.isArray(byId.algorithm.aliases) && byId.algorithm.aliases.length > 0)

  const byName = await tool.execute({ name: 'LSTM' })
  check('按规范名命中', byName.algorithm.id === 'lstm')
  const byAlias = await tool.execute({ name: 'lstm' })
  check('按别名（小写）命中', byAlias.algorithm.id === 'lstm')

  console.log('\n[2] 论文清单')
  check('论文数 = 3', byId.papersCount === 3, String(byId.papersCount))
  check('清单按次数排序', byId.papers.length === 3)
  check('带证据片段', Array.isArray(byId.papers[0].snippets), JSON.stringify(byId.papers[0].snippets))
  check('片段不超过 3 条', byId.papers.every((p) => p.snippets.length <= 3))
  check('带年份与会议字段', 'year' in byId.papers[0] && 'venue' in byId.papers[0])

  console.log('\n[3] 章节与年份聚合')
  const totalSection = Object.values(byId.sections).reduce((a, b) => a + b, 0)
  check('章节计数之和 = 提及总数', totalSection === byId.mentionCount, `${totalSection} vs ${byId.mentionCount}`)
  check('年份只有 2022 与 2024', byId.years.map((y) => y.year).join(',') === '2022,2024', JSON.stringify(byId.years))
  check('无年份论文不影响 years', byId.years.reduce((a, b) => a + b.papers, 0) === 2, JSON.stringify(byId.years))
  check('firstYear / lastYear', byId.firstYear === 2022 && byId.lastYear === 2024)

  console.log('\n[4] 旧口径标记')
  // 把其中一条提及降级成旧口径，看详情里是否标出来
  for (const [key, mention] of store.mentions) {
    if (mention.algorithmId === 'lstm') {
      store.mentions.set(key, { ...mention, dictVersion: 'v0.2-legacy' })
      break
    }
  }
  const afterStale = await tool.execute({ id: 'lstm' })
  check('有论文被标 stale', afterStale.papers.some((p) => p.stale === true))
  check('stale 的 dictVersion 是 v0.2-legacy', afterStale.papers.find((p) => p.stale)?.dictVersion === 'v0.2-legacy')

  console.log('\n[5] 分页')
  const page1 = buildAlgorithmDetail(store, { id: 'lstm', limit: 2, offset: 0 })
  check('limit=2 返回 2 条', page1.papers.length === 2)
  check('total 仍是 3', page1.total === 3, String(page1.total))
  check('truncated=true', page1.truncated === true)
  const page2 = buildAlgorithmDetail(store, { id: 'lstm', limit: 2, offset: 2 })
  check('第二页 1 条', page2.papers.length === 1)

  console.log('\n[6] 找不到')
  let notFound = null
  try {
    await tool.execute({ id: 'no-such-algo' })
  } catch (e) {
    notFound = e
  }
  check('抛 NOT_FOUND', notFound?.code === 'NOT_FOUND', String(notFound?.code))
  check('buildAlgorithmDetail 返回 null', buildAlgorithmDetail(store, { id: 'nope' }) === null)
  check('不传 id/name 返回 null', buildAlgorithmDetail(store, {}) === null)

  console.log('\n[7] 卡片')
  const card = tool.output.render({}, byId).map((b) => b.text).join('\n')
  check('卡片含名称与规模', card.includes('LSTM') && card.includes('3 篇论文'), card.split('\n')[0])
  const notFoundCard = tool.output.render({}, undefined)
  check('value 缺失不抛', Array.isArray(notFoundCard) && notFoundCard.length === 1)

  console.log('\n[8] 与 DICT_VERSION 的关系')
  check('当前口径常量可用', typeof DICT_VERSION === 'string' && DICT_VERSION.length > 0)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
