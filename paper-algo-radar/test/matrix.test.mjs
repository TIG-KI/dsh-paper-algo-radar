/**
 * FR-5.3 验收：领域 × 头部算法矩阵（radar_matrix）。
 *
 * 口径：
 *  - 列 = 论文数最多的前 N 个算法（不是提及数）；
 *  - 行 = 领域，count = 领域论文数；
 *  - 单元格 = 该领域里提及该算法的不同论文数（同篇多次只算 1）；
 *  - 一篇多领域在每行各计一次，但列排序时只算一篇；
 *  - 示例数据默认不计入；支持 field 过滤与 topN 边界。
 *
 * 运行：node test/matrix.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, buildMatrix, buildMatrixTool } = __test
const { READ_TOOL_NAMES } = await import('../lib/contract.js')

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

const dir = await mkdtemp(join(tmpdir(), 'radar-matrix-'))
const store = new Store(join(dir, 'store.json'))
await store.load()

const algorithms = [
  { id: 'transformer', name: 'Transformer', type: 'DL', family: '注意力', aliases: [] },
  { id: 'lstm', name: 'LSTM', type: 'DL', family: '循环网络', aliases: [] },
  { id: 'cnn', name: 'CNN', type: 'DL', family: '卷积', aliases: [] },
  { id: 'svm', name: 'SVM', type: 'ML', family: '核方法', aliases: [] },
]
for (const record of algorithms) store.algorithms.set(record.id, record)

const papers = [
  ['p1', ['NLP'], false],
  ['p2', ['NLP', 'CV'], false],
  ['p3', ['CV'], false],
  ['p4', ['未分类'], false],
  ['p5', ['NLP'], true],
]
for (const [id, fields, isSample] of papers) {
  store.papers.set(id, { id, title: id, fields, isSample, depth: 'fulltext', year: 2024 })
}
const mentions = [
  ['p1', 'transformer'],
  ['p1', 'lstm'],
  ['p2', 'transformer'],
  ['p2', 'cnn'],
  ['p3', 'cnn'],
  ['p4', 'svm'],
  ['p5', 'transformer'],
]
for (const [paperId, algorithmId] of mentions) {
  store.mentions.set(`${paperId}::${algorithmId}`, {
    paperId,
    algorithmId,
    count: 1,
    sections: {},
    snippets: [],
    dictVersion: 'test',
  })
}

try {
  console.log('\n[1] 默认：全部领域、示例不计入、列按论文数')
  {
    const value = buildMatrix(store)
    check('总论文数排除示例（4）', value.totalPapers === 4, String(value.totalPapers))
    check('行按领域计数：NLP 2 / CV 2 / 未分类 1', JSON.stringify(value.rows.map((r) => [r.field, r.count])) === JSON.stringify([['CV', 2], ['NLP', 2], ['未分类', 1]]), JSON.stringify(value.rows.map((r) => [r.field, r.count])))
    check('默认 topN=8', value.topN === 8 && value.algorithms.length === 4, `${value.topN}/${value.algorithms.length}`)
    check('列序 CNN 与 Transformer 同 2 篇，按名字码位排', JSON.stringify(value.algorithms.slice(0, 2).map((a) => a.name)) === JSON.stringify(['CNN', 'Transformer']), JSON.stringify(value.algorithms.map((a) => [a.name, a.papers])))
    check('Transformer 跨 NLP+CV 只算 2 篇（不重复计数）', value.algorithms.find((a) => a.id === 'transformer')?.papers === 2, JSON.stringify(value.algorithms.find((a) => a.id === 'transformer')))
    const nlp = value.rows.find((r) => r.field === 'NLP')
    const cv = value.rows.find((r) => r.field === 'CV')
    const cell = (row, id) => row.cells.find((c) => c.algorithmId === id)?.papers
    check('NLP × Transformer = 2', cell(nlp, 'transformer') === 2, String(cell(nlp, 'transformer')))
    check('NLP × CNN = 1（p2 一篇多领域）', cell(nlp, 'cnn') === 1, String(cell(nlp, 'cnn')))
    check('CV × CNN = 2', cell(cv, 'cnn') === 2, String(cell(cv, 'cnn')))
    check('CV × LSTM = 0（未命中显示 0）', cell(cv, 'lstm') === 0, String(cell(cv, 'lstm')))
    check('cells 与列顺序一一对应', nlp.cells.length === value.algorithms.length && nlp.cells.every((c, i) => c.algorithmId === value.algorithms[i].id))
  }

  console.log('\n[2] field 过滤：只留一行，列也按该领域重排')
  {
    const value = buildMatrix(store, { field: 'NLP' })
    check('只有 NLP 一行', value.rows.length === 1 && value.rows[0].field === 'NLP', JSON.stringify(value.rows.map((r) => r.field)))
    check('NLP 论文数 2', value.rows[0].count === 2 && value.totalPapers === 2, `${value.rows[0].count}/${value.totalPapers}`)
    check('列在 NLP 内按论文数：Transformer 排第一', value.algorithms[0]?.name === 'Transformer' && value.algorithms[0]?.papers === 2, JSON.stringify(value.algorithms.map((a) => [a.name, a.papers])))
    check('NLP 内 LSTM 计 1 篇', value.algorithms.find((a) => a.id === 'lstm')?.papers === 1)
    check('field 回显', value.field === 'NLP')
  }

  console.log('\n[3] 示例数据开关')
  {
    const withSamples = buildMatrix(store, { includeSamples: true })
    check('含示例共 5 篇', withSamples.totalPapers === 5, String(withSamples.totalPapers))
    check('含示例后 Transformer = 3', withSamples.algorithms.find((a) => a.id === 'transformer')?.papers === 3)
  }

  console.log('\n[4] topN 边界与空库')
  {
    const one = buildMatrix(store, { topN: 1 })
    check('topN=1 只留一列', one.algorithms.length === 1 && one.topN === 1)
    const zero = buildMatrix(store, { topN: 0 })
    check('topN=0 夹到 1', zero.topN === 1 && zero.algorithms.length === 1)
    const huge = buildMatrix(store, { topN: 999 })
    check('topN 上限 20', huge.topN === 20)
    const empty = new Store(join(dir, 'empty.json'))
    await empty.load()
    const none = buildMatrix(empty)
    check('空库返回空行空列', none.rows.length === 0 && none.algorithms.length === 0 && none.totalPapers === 0)
  }

  console.log('\n[5] 工具契约与卡片')
  {
    const tool = buildMatrixTool(async () => store)
    check('工具名 radar_matrix', tool.name === 'radar_matrix')
    check('读工具清单包含 radar_matrix', READ_TOOL_NAMES.includes('radar_matrix'))
    check('参数 topN / field 且有描述', tool.parameters.properties.topN && tool.parameters.properties.field && tool.parameters.additionalProperties === false)
    check('声明了 output.schema', tool.output?.schema?.properties?.rows?.type === 'array')
    const result = await tool.execute({ topN: 2 })
    check('execute 返回 2 列 / 4 篇', result.algorithms.length === 2 && result.totalPapers === 4, `${result.algorithms.length}/${result.totalPapers}`)
    const card = tool.output.render({}, result).map((b) => b.text).join('\n')
    check('卡片标题含「领域 × 头部算法」', card.includes('领域 × 头部算法'), card)
    check('卡片含具体领域行', card.includes('NLP') && card.includes('CV'), card)
    check('卡片不铺全量（≤ 9 行）', card.split('\n').length <= 9, String(card.split('\n').length))
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n全部通过：${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
