/**
 * W1.1 验收：示例数据包（§7 FR-11.2）。
 *
 * 关键规则：
 *  - 示例默认**不计入**排行 / 统计 / 趋势 / 覆盖率
 *  - 可重复载入不变两份；clear 只删示例；promote 需二次确认
 *
 * 运行：node test/samples.test.mjs
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, sampleAction, buildState, buildTrends, buildFields, buildSamplesTool } = __test

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

const dir = await mkdtemp(join(tmpdir(), 'radar-samples-'))
const store = new Store(join(dir, 'store.json'))
await store.load()

try {
  console.log('\n[1] 载入示例')
  const loaded = await sampleAction(store, 'load')
  check('载入 6 篇', loaded.added === 6, String(loaded.added))
  check('库里确实有 6 篇', store.papers.size === 6, String(store.papers.size))
  const samples = [...store.papers.values()].filter((paper) => paper.isSample === true)
  check('全部标记 isSample', samples.length === 6, String(samples.length))
  check('示例都抽到了算法', samples.every((paper) => (paper.hitCount ?? 0) > 0), JSON.stringify(samples.map((p) => p.hitCount)))
  check('示例都留存了正文', samples.every((paper) => paper.hasText === true))
  check('texts/ 下有 6 个正文文件', (await readdir(join(dir, 'texts'))).length === 6)

  console.log('\n[2] 默认不计入统计')
  const state = buildState(store, { paperLimit: 100 })
  check('paperCount=0（示例不算）', state.paperCount === 0, String(state.paperCount))
  check('algorithmCount=0', state.algorithmCount === 0, String(state.algorithmCount))
  check('mentionCount=0', state.mentionCount === 0, String(state.mentionCount))
  check('sampleCount=6', state.sampleCount === 6, String(state.sampleCount))
  check('totalPaperCount=6', state.totalPaperCount === 6, String(state.totalPaperCount))
  check('papers 列表为空', state.papers.length === 0, String(state.papers.length))
  check('fields 为空', state.fields.length === 0, String(state.fields.length))

  console.log('\n[3] 带 includeSamples 时才计入')
  const withSamples = buildState(store, { paperLimit: 100, includeSamples: true })
  check('paperCount=6', withSamples.paperCount === 6, String(withSamples.paperCount))
  check('算法数 > 0', withSamples.algorithmCount > 0, String(withSamples.algorithmCount))
  check('papers 有 6 条', withSamples.papers.length === 6, String(withSamples.papers.length))
  check('每条论文带 types', withSamples.papers.every((p) => Array.isArray(p.types)))

  console.log('\n[4] 趋势与领域也排除示例')
  const trendsDefault = buildTrends(store, {})
  check('默认趋势无序列', trendsDefault.series.length === 0, String(trendsDefault.series.length))
  const trendsAll = buildTrends(store, { includeSamples: true })
  check('includeSamples 后有序列', trendsAll.series.length > 0, String(trendsAll.series.length))
  check('年份有跨度', trendsAll.yearMax - trendsAll.yearMin >= 3, `${trendsAll.yearMin}-${trendsAll.yearMax}`)
  const fieldsDefault = buildFields(store)
  check('默认领域为空', fieldsDefault.fields.length === 0 && fieldsDefault.total === 0)
  const fieldsAll = buildFields(store, { includeSamples: true })
  check('includeSamples 后有领域', fieldsAll.fields.length > 0, JSON.stringify(fieldsAll.fields))

  console.log('\n[5] 重复载入不变两份')
  const again = await sampleAction(store, 'load')
  check('第二次新增 0', again.added === 0, String(again.added))
  check('6 篇被复用', again.reused === 6, String(again.reused))
  check('库里仍是 6 篇', store.papers.size === 6, String(store.papers.size))

  console.log('\n[6] 真实数据不受影响')
  const real = await ingestPaper(store, {
    title: '真实论文一篇',
    text: '摘　要：本文使用 LSTM 与 CRF 做命名实体识别。'.padEnd(340, '补充说明用于满足最小长度。'),
    year: 2024,
  })
  const mixed = buildState(store, { paperLimit: 100 })
  check('统计只算真实数据', mixed.paperCount === 1, String(mixed.paperCount))
  check('真实论文在列表里', mixed.papers.length === 1 && mixed.papers[0].id === real.paper.id)
  check('示例仍单列', mixed.sampleCount === 6, String(mixed.sampleCount))
  const mixedAll = buildState(store, { paperLimit: 100, includeSamples: true })
  check('含示例时 7 篇', mixedAll.paperCount === 7, String(mixedAll.paperCount))

  console.log('\n[7] 转正需二次确认')
  let noConfirm = null
  try {
    await sampleAction(store, 'promote', {})
  } catch (e) {
    noConfirm = e
  }
  check('缺 confirm 抛 VALIDATION', noConfirm?.code === 'VALIDATION' && noConfirm?.field === 'confirm', String(noConfirm?.code))
  check('缺 confirm 时没改数据', buildState(store, {}).sampleCount === 6)

  const promoted = await sampleAction(store, 'promote', { confirm: true })
  check('转正 6 篇', promoted.promoted === 6, String(promoted.promoted))
  const afterPromote = buildState(store, { paperLimit: 100 })
  check('转正后计入统计', afterPromote.paperCount === 7, String(afterPromote.paperCount))
  check('sampleCount 归零', afterPromote.sampleCount === 0, String(afterPromote.sampleCount))

  console.log('\n[8] clear 只删示例')
  const store2 = new Store(join(dir, 'b.json'))
  await store2.load()
  await sampleAction(store2, 'load')
  const real2 = await ingestPaper(store2, {
    title: '另一篇真实论文',
    text: '摘　要：本文使用 SVM 与随机森林做分类。'.padEnd(340, '补充说明用于满足最小长度。'),
  })
  const cleared = await sampleAction(store2, 'clear')
  check('清掉 6 篇示例', cleared.cleared === 6, String(cleared.cleared))
  check('真实论文还在', store2.papers.has(real2.paper.id))
  check('库里只剩 1 篇', store2.papers.size === 1, String(store2.papers.size))

  console.log('\n[9] 工具与错误路径')
  const tool = buildSamplesTool(async () => store2)
  let bad = null
  try {
    await tool.execute({ action: 'nope' })
  } catch (e) {
    bad = e
  }
  check('未知 action → VALIDATION', bad?.code === 'VALIDATION' && bad?.field === 'action')
  const card = tool.output.render({}, { action: 'load', added: 6, total: 6 }).map((b) => b.text).join('\n')
  check('卡片说明不计入统计', card.includes('不计入统计'), card)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
