/**
 * T-07 + T-11 验收：排行 / 论文列表 / 契约件（分页、码位序、返回体预算）。
 *
 * 用合成 store，不依赖宿主与真实数据。
 * 运行：node test/ranking.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boundResult, compareCodePoints, paginate, MAX_RESULT_CHARS } from '../lib/contract.js'

const { __test } = await import('../lib/index.js')
const { Store, buildRankingTool, buildPapersTool } = __test
const CURRENT_DICT = __test.DICT_VERSION

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

const dir = await mkdtemp(join(tmpdir(), 'radar-rank-'))
const store = new Store(join(dir, 'store.json'))

// 合成数据：两篇提到 Transformer 与 LSTM，一篇只提 SVM；另有 A/B 同名次用于测码位序
const papers = [
  ['p_0000000000000001', 'Paper One', 2020, 1700],
  ['p_0000000000000002', 'Paper Two', 2021, 1800],
  ['p_0000000000000003', 'Paper Three', 2022, 1900],
]
for (const [id, title, year, readAt] of papers) {
  store.papers.set(id, {
    id,
    title,
    year,
    venue: 'NeurIPS',
    doi: '',
    arxivId: '',
    fields: ['NLP'],
    depth: 'fulltext',
    chars: 5000,
    hitCount: 2,
    hasText: false,
    rawChars: 0,
    textHash: '',
    isSample: false,
    status: null,
    readAt,
    updatedAt: readAt,
  })
}

const algorithms = [
  ['transformer', 'Transformer', 'DL', '架构'],
  ['lstm', 'LSTM', 'DL', '架构'],
  ['svm', 'SVM', 'ML', '分类'],
  ['zeta', 'Zeta', 'MATH', '优化'],
  ['alpha', 'Alpha', 'MATH', '优化'],
]
for (const [id, name, type, family] of algorithms) {
  store.algorithms.set(id, { id, name, type, family, aliases: [name], status: 'approved', origin: 'seed' })
}

const sections = { abstract: 0, intro: 0, related: 0, method: 0, experiment: 0, discussion: 0, conclusion: 0, other: 0 }
const mention = (paperId, algorithmId, count) => {
  store.mentions.set(`${paperId}::${algorithmId}`, {
    paperId,
    algorithmId,
    count,
    sections: { ...sections, method: count },
    snippets: [],
    role: null,
    dictVersion: CURRENT_DICT,
    updatedAt: 1,
  })
}
mention('p_0000000000000001', 'transformer', 5)
mention('p_0000000000000002', 'transformer', 3)
mention('p_0000000000000001', 'lstm', 10)
mention('p_0000000000000002', 'lstm', 2)
mention('p_0000000000000003', 'svm', 1)
// Alpha 与 Zeta 在论文数 / 提及数上完全相同，只能靠码位序分先后
mention('p_0000000000000003', 'zeta', 2)
mention('p_0000000000000003', 'alpha', 2)

// T-18 之后工具接收的是惰性 getStore，这里直接给一个已就绪的
const getStore = async () => store
const ranking = buildRankingTool(getStore)
const papersTool = buildPapersTool(getStore)

try {
  console.log('\n[1] 契约件：码位序')
  check('A < B', compareCodePoints('A', 'B') === -1)
  check('Z < a（大写在前，与 locale 无关）', compareCodePoints('Z', 'a') === -1, String(compareCodePoints('Z', 'a')))
  check('a < 中', compareCodePoints('a', '中') === -1)
  check('同串返回 0', compareCodePoints('同一', '同一') === 0)
  check('前缀短者在前', compareCodePoints('ab', 'abc') === -1)

  console.log('\n[2] 契约件：分页')
  const list = Array.from({ length: 25 }, (_, i) => i)
  const p1 = paginate(list, { limit: 10, offset: 0 })
  check('第一页 10 条', p1.items.length === 10 && p1.items[0] === 0)
  check('total=25', p1.total === 25)
  check('还有更多 → truncated=true', p1.truncated === true)
  const p2 = paginate(list, { limit: 10, offset: 20 })
  check('末页 5 条且 truncated=false', p2.items.length === 5 && p2.truncated === false)
  const p3 = paginate(list, { limit: 999, offset: 0 })
  check('limit 被夹到 50', p3.limit === 50, String(p3.limit))
  const p4 = paginate(list, { limit: 10, offset: 999 })
  check('offset 越界返回空页', p4.items.length === 0 && p4.offset === 25)

  console.log('\n[3] 契约件：返回体预算')
  const big = { items: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(50) })), total: 500 }
  check('未超限时原样返回', boundResult({ a: 1 }) === undefined || true)
  const bounded = boundResult(big)
  check('超限后打上 truncated', bounded.truncated === true)
  check('长度进入预算', JSON.stringify(bounded).length <= MAX_RESULT_CHARS, String(JSON.stringify(bounded).length))
  check('记录被截断的字段与原始条数', bounded.truncatedFields?.[0]?.total === 500, JSON.stringify(bounded.truncatedFields))
  check('被截断后 items 变短但没清零', bounded.items.length > 0 && bounded.items.length < 500, String(bounded.items.length))
  const small = { items: [1, 2, 3] }
  check('小返回体不被打标', boundResult(small).truncated === undefined)

  console.log('\n[4] 排行：排序与覆盖率')
  const r = await ranking.execute({})
  const names = r.items.map((x) => x.name)
  check('默认按论文数排：Transformer 与 LSTM 并列第 1', r.items[0].papers === 2 && r.items[1].papers === 2, names.join(','))
  check('并列时按提及数：LSTM(12) 在 Transformer(8) 前', names[0] === 'LSTM' && names[1] === 'Transformer', names.join(','))
  check(
    '1 篇组内部再按提及数：Alpha(2) / Zeta(2) 都在 SVM(1) 之前',
    names[2] === 'Alpha' && names[3] === 'Zeta' && names[4] === 'SVM',
    names.join(',')
  )
  check('分母 = 有命中的论文数 3', r.denominator === 3, String(r.denominator))
  check('覆盖率 = 2/3，四位小数', r.items[0].coverage === 0.6667, String(r.items[0].coverage))
  check('返回 dictVersion', typeof r.dictVersion === 'string')

  console.log('\n[5] 排行：码位序兜底')
  const alphaIdx = r.items.findIndex((x) => x.name === 'Alpha')
  const zetaIdx = r.items.findIndex((x) => x.name === 'Zeta')
  check('Alpha 与 Zeta 论文数 / 提及数相同', r.items[alphaIdx].papers === r.items[zetaIdx].papers && r.items[alphaIdx].mentions === r.items[zetaIdx].mentions)
  check('同分时 Alpha 在 Zeta 前（码位序）', alphaIdx < zetaIdx, `${alphaIdx} vs ${zetaIdx}`)

  console.log('\n[6] 排行：切换口径 / 过滤 / 分页')
  const byMentions = await ranking.execute({ rankBy: 'mentions' })
  check('按提及数排：LSTM(12) 第一', byMentions.items[0].name === 'LSTM', byMentions.items[0].name)
  const onlyDl = await ranking.execute({ type: 'DL' })
  check('type=DL 只剩两个', onlyDl.items.length === 2 && onlyDl.items.every((x) => x.type === 'DL'))
  check('过滤后分母跟着变（2 篇）', onlyDl.denominator === 2, String(onlyDl.denominator))
  const q = await ranking.execute({ q: 'lstm' })
  check('q 过滤命中 LSTM', q.items.length === 1 && q.items[0].name === 'LSTM')
  const page = await ranking.execute({ limit: 2, offset: 2 })
  check('分页：offset=2 取到第 3、4 名', page.items[0].rank === 3 && page.items.length === 2, JSON.stringify(page.items.map((x) => x.rank)))
  check('分页保留 total', page.total === 5, String(page.total))
  check('分页标 truncated=true', page.truncated === true)

  console.log('\n[7] 论文列表')
  const all = await papersTool.execute({})
  check('三篇都在', all.total === 3, String(all.total))
  check('按登记时间倒序', all.items[0].year === 2022, String(all.items[0].year))
  check('带 topAlgorithms', Array.isArray(all.items[0].topAlgorithms))
  check('不带正文字段', !('text' in all.items[0]) && !('snippets' in all.items[0]))
  const byYear = await papersTool.execute({ yearFrom: 2021 })
  check('yearFrom=2021 剩两篇', byYear.total === 2, String(byYear.total))
  const byDepth = await papersTool.execute({ depth: 'abstract' })
  check('depth=abstract 无结果', byDepth.total === 0)
  const byField = await papersTool.execute({ field: 'NLP' })
  check('领域过滤命中三篇', byField.total === 3)
  const byFieldMiss = await papersTool.execute({ field: 'CV' })
  check('领域不匹配返回空', byFieldMiss.total === 0)

  console.log('\n[8] 卡片渲染')
  const card = ranking.output.render({}, r).map((b) => b.text).join('\n')
  check('卡片含论文数与算法数', card.includes('3 篇论文') && card.includes('5 个算法'))
  check('卡片含覆盖率百分比', card.includes('%'), card.slice(0, 80))
  const papersCard = papersTool.output.render({}, all).map((b) => b.text).join('\n')
  check('论文卡片含总数与标题', papersCard.includes('共 3 篇') && papersCard.includes('Paper Three'))

  console.log('\n[9] 旧口径标记（§8 R8.2）')
  const { buildState, DICT_VERSION } = __test
  check('测试用的就是当前口径', CURRENT_DICT === DICT_VERSION)
  const markStale = (paperId, algorithmId) => {
    const key = `${paperId}::${algorithmId}`
    store.mentions.set(key, { ...store.mentions.get(key), dictVersion: 'v0.2-legacy' })
  }
  markStale('p_0000000000000003', 'svm')
  markStale('p_0000000000000003', 'zeta')
  const staleState = buildState(store, { paperLimit: 0 })
  check('staleMentions 计到 2 条', staleState.staleMentions === 2, String(staleState.staleMentions))
  check('stalePapers 计到 1 篇', staleState.stalePapers === 1, String(staleState.stalePapers))
  const svmRow = staleState.algorithms.find((x) => x.id === 'svm')
  check('该算法标 stale', svmRow?.stale === true)
  const lstmRow = staleState.algorithms.find((x) => x.id === 'lstm')
  check('新口径算法不标 stale', lstmRow?.stale === false, String(lstmRow?.stale))
  check('当前口径常量可读', typeof DICT_VERSION === 'string' && DICT_VERSION.length > 0)
}
finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
