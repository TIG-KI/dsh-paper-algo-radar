/**
 * W2.0 验收：新词候选队列（§7 FR-2.8）。
 *
 * 定位很关键：插件**不调 LLM**；它提供队列，模型负责发现、用户负责采纳。
 *
 * 运行：node test/candidates.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, dictVersionOf, SEED_DICT_VERSION } = __test
const { addCandidate, candidateStats, listCandidates, markCandidateApproved, rejectCandidate } = await import(
  '../lib/candidates.js'
)

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

const dir = await mkdtemp(join(tmpdir(), 'radar-cand-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
const getStore = async () => store

try {
  console.log('\n[1] 提交候选')
  const first = await addCandidate(store, { name: 'Mamba', note: '状态空间模型', paperId: 'p_x' })
  check('created=true', first.created === true)
  check('状态是 pending', first.item.status === 'pending')
  check('pending=1', first.pending === 1, String(first.pending))
  check('记下了 paperId', first.item.paperId === 'p_x')

  const again = await addCandidate(store, { name: 'mamba' })
  check('重复提交不新增', again.created === false, String(again.created))
  check('seen 累加', again.item.seen === 2, String(again.item.seen))
  check('仍然只有 1 条', listCandidates(store).length === 1, String(listCandidates(store).length))

  console.log('\n[2] 列表与统计')
  await addCandidate(store, { name: 'RWKV' })
  check('两条候选', listCandidates(store).length === 2)
  const stats = candidateStats(store)
  check('pending=2', stats.pending === 2, JSON.stringify(stats))
  check('total=2', stats.total === 2)
  check('按状态过滤', listCandidates(store, { status: 'pending' }).length === 2)

  console.log('\n[3] 拒绝')
  const rejected = await rejectCandidate(store, 'RWKV')
  check('状态 rejected', rejected.item.status === 'rejected')
  check('pending 降到 1', rejected.pending === 1, String(rejected.pending))
  check('记录还在（不被当新词）', listCandidates(store).length === 2)
  const reAdd = await addCandidate(store, { name: 'rwkv' })
  check('拒绝过的不再当新候选', reAdd.created === false, String(reAdd.created))

  console.log('\n[4] 工具层：approve 真的写进词典并推口径')
  const { buildCandidatesTool } = __test
  const tool = buildCandidatesTool(getStore)
  const beforeVersion = dictVersionOf(store)
  const approved = await tool.execute({ action: 'approve', id: 'Mamba', type: 'DL', family: '架构', aliases: ['mamba'] })
  check('返回了词典条目', approved.entry?.name === 'Mamba', JSON.stringify(approved.entry))
  check('词典里真的有', store.algorithms.get(approved.entry.id)?.name === 'Mamba')
  check('口径版本 +1', approved.version === `${beforeVersion}+1`, `${approved.version}`)
  check('候选状态 approved', approved.item.status === 'approved')
  check('记下了 dictEntryId', approved.item.dictEntryId === approved.entry.id)
  check('pending 归零', approved.pending === 0, String(approved.pending))

  const list = await tool.execute({ action: 'list' })
  check('list 能看到两条', list.items.length === 2)
  const card = tool.output.render({}, list).map((b) => b.text).join('\n')
  check('卡片标出状态', card.includes('approved') || card.includes('rejected'), card)

  console.log('\n[5] 采纳后的词能被抽取命中')
  let text = '摘　要：本文使用 Mamba 做长序列建模，并与 Transformer 对比。'
  while (text.length < 340) text += '补充说明用于满足最小正文长度，不引入额外方法名称。'
  const paper = await ingestPaper(store, { title: 'Mamba 测试', text, year: 2024 })
  check('抽到了新采纳的词', paper.hits.some((hit) => hit.id === approved.entry.id), paper.hits.map((h) => h.id).join(','))

  console.log('\n[6] 候选名已经在词典里 → 不造重复词条')
  {
    // 造一条与候选同名的词条，再采纳同名候选
    store.algorithms.set('seedish', { id: 'seedish', name: 'FlashAttention', type: 'DL', family: '架构', aliases: [], status: 'approved', origin: 'seed' })
    await addCandidate(store, { name: 'FlashAttention' })
    const versionBefore = dictVersionOf(store)
    const tool2 = buildCandidatesTool(getStore)
    const dup = await tool2.execute({ action: 'approve', id: 'FlashAttention' })
    check('alreadyInDictionary=true', dup.alreadyInDictionary === true, JSON.stringify(dup.alreadyInDictionary))
    check('复用已有 id', dup.entry.id === 'seedish', String(dup.entry.id))
    check('口径版本没变', dictVersionOf(store) === versionBefore, `${dictVersionOf(store)} vs ${versionBefore}`)
    check('没有生成第二条同名', [...store.algorithms.values()].filter((e) => e.name === 'FlashAttention').length === 1)
    check('候选状态 approved', dup.item.status === 'approved')
  }

  console.log('\n[7] 错误路径')
  let notFound = null
  try {
    await tool.execute({ action: 'approve', id: '不存在的候选' })
  } catch (error) {
    notFound = error
  }
  check('采纳不存在的候选 → NOT_FOUND', notFound?.code === 'NOT_FOUND', String(notFound?.code))
  let badAction = null
  try {
    await tool.execute({ action: 'what' })
  } catch (error) {
    badAction = error
  }
  check('未知操作 → VALIDATION', badAction?.code === 'VALIDATION', String(badAction?.code))
  let noName = null
  try {
    await addCandidate(store, { name: '' })
  } catch (error) {
    noName = error
  }
  check('空名字报错', String(noName?.message ?? '').includes('缺少候选名'))

  console.log('\n[8] 上限')
  for (let i = 0; i < 220; i += 1) await addCandidate(store, { name: `候选词 ${i}` })
  check('候选最多 200 条', listCandidates(store, { limit: 500 }).length <= 200, String(listCandidates(store, { limit: 500 }).length))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
