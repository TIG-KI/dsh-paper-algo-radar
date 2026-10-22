/**
 * T-06 验收：工具契约（§10.1 / FR-8.3 / §8 R12）。
 *
 * 只检查「模型看到的那一面」：名字、参数、输出 schema、卡片渲染。
 * 不检查实现——那是 dedupe / extract 两套测试的事。
 * 运行：node test/tools.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, buildAddTool, buildRankingTool, buildDiscoverTool, buildAddBatchTool } = __test

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

const dir = await mkdtemp(join(tmpdir(), 'radar-tools-'))
const store = new Store(join(dir, 'store.json'))
await store.load()

const add = buildAddTool(store)
const ranking = buildRankingTool(store)
const fakeCtx = { tools: { get: () => undefined } }
const discover = buildDiscoverTool(store, fakeCtx)
const batch = buildAddBatchTool(store)

try {
  console.log('\n[1] 命名空间')
  check('登记工具叫 radar_add', add.name === 'radar_add', add.name)
  check('排行工具叫 radar_ranking', ranking.name === 'radar_ranking', ranking.name)
  check('检索工具叫 radar_discover', discover.name === 'radar_discover', discover.name)
  check('批量登记工具叫 radar_add_batch', batch.name === 'radar_add_batch', batch.name)
  check('不再有 algo_ 前缀', ![add.name, ranking.name, discover.name, batch.name].some((n) => n.startsWith('algo_')))

  console.log('\n[2] radar_add 的入参契约')
  const p = add.parameters
  check('顶层是 object 且 additionalProperties=false', p.type === 'object' && p.additionalProperties === false)
  // W1.0 起有两种登记方式（粘贴正文 / 快速添加 input），JSON Schema 表达不了 XOR，
  // 所以 required 为空数组，缺参由 execute 里的校验给出明确报错
  check('required 为空（两种用法二选一，交给运行时校验）', Array.isArray(p.required) && p.required.length === 0, JSON.stringify(p.required))
  check('声明了 input 参数', typeof p.properties.input?.type === 'string' && p.properties.input.type === 'string')
  check('描述里写清两种用法', add.description.includes('input') && add.description.includes('粘贴正文'))
  check('每个字段都有 description', Object.values(p.properties).every((v) => typeof v.description === 'string' && v.description.length > 0))
  check('depth 限定 fulltext / abstract', JSON.stringify(p.properties.depth.enum) === JSON.stringify(['fulltext', 'abstract']))
  check('声明了 arxivId 与 source', 'arxivId' in p.properties && 'source' in p.properties)

  console.log('\n[3] radar_add 的出参契约（R12 上下文预算）')
  const schema = add.output.schema
  for (const key of ['paper', 'created', 'hits', 'total', 'chars', 'depth', 'warnings']) {
    check(`输出声明了 ${key}`, key in schema.properties)
  }
  check('描述里写明不回显正文', add.description.includes('不回显正文'), add.description.slice(0, 60))

  console.log('\n[4] 卡片渲染')
  const value = {
    paper: { id: 'p_1', title: '一篇很长的论文标题'.repeat(6) },
    created: true,
    hits: [
      { name: 'LSTM', type: 'DL', count: 3 },
      { name: 'Transformer', type: 'DL', count: 2 },
      { name: 'Adam', type: 'MATH', count: 2 },
      { name: 'SVM', type: 'ML', count: 1 },
    ],
    total: 4,
    chars: 328,
    depth: 'fulltext',
    warnings: ['suspect:short'],
  }
  const card = add.output.render({}, value)
  const text = card.map((b) => b.text).join('\n')
  const lines = text.split('\n')
  check('卡片 ≤ 6 行', lines.length <= 6, String(lines.length))
  check('写明了已登记与标题', text.includes('已登记') && text.includes('一篇很长的论文标题'))
  check('给出算法数 / 字符数 / 深度', text.includes('4 个算法') && text.includes('328 字符') && text.includes('全文'))
  check('只列前 3 个并注明其余', text.includes('LSTM') && text.includes('其余 1 个略'))
  check('带上告警', text.includes('suspect:short'))
  check('卡片不含正文（这里没有正文可含，但要保证不回显入参）', !text.includes('【正文】'))

  const updated = add.output.render({}, { ...value, created: false })
  check('覆盖更新时写「已更新」', updated.map((b) => b.text).join('').includes('已更新'))

  const empty = add.output.render({}, { paper: { title: 'x' }, created: true, hits: [], total: 0, chars: 100, depth: 'abstract', warnings: [] })
  check('零命中时给解释', empty.map((b) => b.text).join('').includes('没有识别到'))

  const bad = add.output.render({}, undefined)
  check('value 缺失时不抛', Array.isArray(bad) && bad.length === 1)

  console.log('\n[5] 并发与超时')
  check('radar_add 非并发安全', add.isConcurrencySafe() === false)
  check('radar_discover 有 timeoutMs', typeof discover.timeoutMs === 'number' && discover.timeoutMs >= 60000, String(discover.timeoutMs))
  check('radar_add_batch 有 timeoutMs', typeof batch.timeoutMs === 'number' && batch.timeoutMs >= 120000, String(batch.timeoutMs))
  check('radar_discover 描述里写明不登记', discover.description.includes('不登记'), discover.description.slice(0, 40))
  check('radar_add_batch 描述里写明失败隔离', batch.description.includes('单条失败只影响该条'), batch.description.slice(0, 40))

  console.log('\n[6] 排行工具仍然可用')
  const rankValue = {
    paperCount: 5,
    mentionCount: 124,
    total: 13,
    items: [{ rank: 1, name: 'CNN', type: 'DL', papers: 2, mentions: 45, coverage: 0.4 }],
    truncated: false,
  }
  const rankCard = ranking.output.render({}, rankValue).map((b) => b.text).join('\n')
  check('排行卡片含论文数与算法行', rankCard.includes('5 篇论文') && rankCard.includes('CNN'), rankCard.slice(0, 80))
  check('排行卡片含覆盖率', rankCard.includes('40%'), rankCard.slice(0, 80))
  const emptyRank = ranking.output.render({}, { items: [] }).map((b) => b.text).join('')
  check('空排行给解释', emptyRank.includes('没有符合条件'))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
