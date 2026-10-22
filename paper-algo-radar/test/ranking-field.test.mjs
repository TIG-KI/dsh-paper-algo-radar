/**
 * E35 · BUG-1 回归：`radar_ranking` 的 field 过滤。
 *
 * 三条硬验收：
 *  1. 两个不同 field 的输出必须不同；
 *  2. 覆盖率分母 = 该领域论文数（不是全库）；
 *  3. 同一领域同一算法的篇数，与 `radar_matrix` 的 cells **逐项相等**。
 *
 * 运行：node test/ranking-field.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, buildRankingTool, buildMatrix, buildState } = __test

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
  while ([...text].length < 340) text += FILLER
  if ([...text].length < 300) throw new Error('测试正文太短')
  return text
}

const dir = await mkdtemp(join(tmpdir(), 'radar-e35-'))
const store = new Store(join(dir, 'radar.json'))
await store.load()
const getStore = async () => store
const ranking = buildRankingTool(getStore)

try {
  // 领域 A：4 篇（LSTM + CNN），年份 2020–2022
  await ingestPaper(store, { title: 'A1 LSTM 基线', year: 2020, fields: '领域A', text: body('A1', '使用 LSTM 与 CNN。') })
  await ingestPaper(store, { title: 'A2 LSTM 改进', year: 2021, fields: '领域A', text: body('A2', '使用 LSTM 与 Adam。') })
  await ingestPaper(store, { title: 'A3 CNN 对比', year: 2022, fields: '领域A', text: body('A3', '使用 CNN。') })
  // A4 是多标签，同时属于 A 和 B，并且带 Transformer
  await ingestPaper(store, { title: 'A4 跨领域', year: 2021, fields: '领域A,领域B', text: body('A4', '使用 Transformer 与 SVM。') })
  // 领域 B：另外 3 篇（SVM），年份 2015–2016
  await ingestPaper(store, { title: 'B1 SVM 早期', year: 2015, fields: '领域B', text: body('B1', '使用 SVM。') })
  await ingestPaper(store, { title: 'B2 SVM 对比', year: 2016, fields: '领域B', text: body('B2', '使用 SVM 与 LSTM 对比。') })
  await ingestPaper(store, { title: 'B3 传统方法', year: 2016, fields: '领域B', text: body('B3', '使用 SVM 与随机森林。') })

  const allState = buildState(store, { paperLimit: 0 })
  const totalPapers = allState.paperCount
  console.log(`\n[0] 基线：全库 ${totalPapers} 篇`)

  console.log('\n[1] 两个领域的输出必须不同')
  const a = await ranking.execute({ field: '领域A', limit: 50 })
  const b = await ranking.execute({ field: '领域B', limit: 50 })
  const topA = a.items[0]
  const topB = b.items[0]
  check('领域A 有结果', a.items.length > 0)
  check('领域B 有结果', b.items.length > 0)
  check('Top1 名称不同', topA.name !== topB.name, `${topA.name} vs ${topB.name}`)
  check('两份结果整体不同', JSON.stringify(a.items) !== JSON.stringify(b.items))

  console.log('\n[2] 分母 = 该领域论文数')
  check('领域A 分母 = 4', a.denominator === 4, String(a.denominator))
  check('领域B 分母 = 4', b.denominator === 4, String(b.denominator))
  check('分母不是全库', a.denominator !== totalPapers, `${a.denominator} vs ${totalPapers}`)
  check('paperCount 仍是全库（语义不变）', a.paperCount === totalPapers, String(a.paperCount))
  const lstmA = a.items.find((item) => item.id === 'lstm')
  // 领域A 里命中 LSTM 的是 A1、A2 两篇（B2 属于领域B），所以 2/4 = 0.5
  check('领域A 的 LSTM 覆盖率 = 2/4', lstmA.coverage === 0.5, String(lstmA.coverage))

  console.log('\n[3] 与 matrix 逐项相等（RI-7）')
  const matrixA = buildMatrix(store, { field: '领域A', topN: 20 })
  const matrixB = buildMatrix(store, { field: '领域B', topN: 20 })
  check('matrix 单行（领域A）', matrixA.rows.length === 1, String(matrixA.rows.length))
  check('matrix 行论文数 = 4', matrixA.rows[0].count === 4, String(matrixA.rows[0].count))
  const cellOf = (matrix, algorithmId) => matrix.rows[0].cells.find((cell) => cell.algorithmId === algorithmId)?.papers
  let mismatches = []
  for (const item of a.items) {
    const cell = cellOf(matrixA, item.id)
    if (cell === undefined) continue
    if (cell !== item.papers) mismatches.push(`${item.name}: ranking=${item.papers} matrix=${cell}`)
  }
  check('领域A 全部算法与 matrix 一致', mismatches.length === 0, mismatches.join('; '))
  let mismatchesB = []
  for (const item of b.items) {
    const cell = cellOf(matrixB, item.id)
    if (cell === undefined) continue
    if (cell !== item.papers) mismatchesB.push(`${item.name}: ranking=${item.papers} matrix=${cell}`)
  }
  check('领域B 全部算法与 matrix 一致', mismatchesB.length === 0, mismatchesB.join('; '))

  console.log('\n[4] 年份区间在领域内重算')
  const lstmState = a.items.find((item) => item.id === 'lstm')
  check('领域A 的 LSTM 首见 2020（不含 B 的 2016）', lstmState.firstYear === 2020, String(lstmState.firstYear))
  check('领域A 的 LSTM 最近 2021', lstmState.lastYear === 2021, String(lstmState.lastYear))
  const svmB = b.items.find((item) => item.id === 'svm')
  check('领域B 的 SVM 首见 2015', svmB.firstYear === 2015, String(svmB.firstYear))

  console.log('\n[5] 其余语义保持不变')
  const noField = await ranking.execute({ limit: 50 })
  check('无 field 时分母 = 全库', noField.denominator === totalPapers, String(noField.denominator))
  const typed = await ranking.execute({ field: '领域A', type: 'ML', limit: 50 })
  check('field + type 组合可用', typed.items.every((item) => item.type === 'ML'), typed.items.map((i) => i.type).join(','))
  check('field + type 分母仍限定在领域内', typed.denominator <= 4, String(typed.denominator))
  const queried = await ranking.execute({ field: '领域A', q: 'lstm' })
  check('field + q 组合可用', queried.items.length > 0 && queried.items.every((item) => /lstm/i.test(item.name)), queried.items.map((i) => i.name).join(','))
  const sortedNoField = await ranking.execute({ field: '领域A', rankBy: 'mentions', limit: 50 })
  check('rankBy=mentions 在领域内也生效', sortedNoField.items[0].mentions >= sortedNoField.items.at(-1).mentions)
  const emptyField = await ranking.execute({ field: '不存在的领域' })
  check('不存在的领域 → 空结果且分母 0', emptyField.items.length === 0 && emptyField.denominator === 0, JSON.stringify({ n: emptyField.items.length, d: emptyField.denominator }))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
