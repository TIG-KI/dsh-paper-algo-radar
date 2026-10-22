/**
 * W1.2 验收：词典管理（§7 FR-2.7）+ 口径版本联动。
 *
 * 最关键的一条链路：**改词典 → 口径版本 +1 → 旧提及变旧口径 → 可重算**。
 *
 * 运行：node test/dict.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const {
  Store,
  ingestPaper,
  buildState,
  buildDictionaryView,
  buildDictionaryTool,
  buildReextractTool,
  dictVersionOf,
  SEED_DICT_VERSION,
} = __test

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
  let text = `摘　要：本文研究${topic}。方法上使用 LSTM 与 CRF，并以 Adam 优化。`
  while (text.length < 340) text += FILLER
  return text
}

const grantingCtx = { get: () => ({ request: async () => 'allowed-once' }) }
const exec = { agent: {}, name: 'radar_dictionary' }

const dir = await mkdtemp(join(tmpdir(), 'radar-dict-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
// 手动灌种子（模拟真实宿主里 seedAlgorithms 的结果）
const { LEXICON } = __test
for (const entry of LEXICON) {
  store.algorithms.set(entry.id, { ...entry, status: 'approved', origin: 'seed' })
}
const getStore = async () => store

try {
  console.log('\n[1] 初始状态')
  check('口径等于种子版本', dictVersionOf(store) === SEED_DICT_VERSION, dictVersionOf(store))
  const view = buildDictionaryView(store)
  check('条目数 = 种子数', view.count === LEXICON.length, `${view.count} vs ${LEXICON.length}`)
  check('没有自定义条目', view.customCount === 0)

  const tool = buildDictionaryTool(getStore, grantingCtx)
  const list = await tool.execute({ action: 'list' })
  check('list 返回 entries', Array.isArray(list.entries) && list.entries.length > 0)

  console.log('\n[2] 新增自定义条目 → 能被抽取命中')
  const added = await tool.execute({ action: 'add', name: '图注意力网络', type: 'DL', family: '架构', aliases: ['GAT', 'graph attention network'] })
  check('新增成功', added.entry?.id !== undefined, JSON.stringify(added.entry))
  check('口径版本 +1', added.version === `${SEED_DICT_VERSION}+1`, String(added.version))
  check('带 origin=custom', added.entry.origin === 'custom')

  // 正文里必须真的出现新词（GAT），否则抽取当然命中不到——这是测试文本的问题，不是实现的问题
  const paper = await ingestPaper(store, { title: 'GAT 测试', text: body('图学习，其中 GAT 用于聚合邻居'), year: 2024 })
  const ids = paper.hits.map((hit) => hit.id)
  check('新词被 PLA 抽取命中', ids.includes(added.entry.id), ids.join(','))
  check('提及写入当前口径', store.mentions.get(`${paper.paper.id}::${added.entry.id}`)?.dictVersion === added.version)

  console.log('\n[3] 加别名 → 命中数变化')
  const beforeHits = paper.hits.find((hit) => hit.id === added.entry.id)?.count ?? 0
  const updated = await tool.execute({ action: 'update', id: added.entry.id, aliases: ['GAT', 'graph attention network', '图注意力'] })
  check('更新成功', updated.entry.aliases.includes('图注意力'))
  check('口径再 +1', updated.version === `${SEED_DICT_VERSION}+2`, String(updated.version))

  const paper2 = await ingestPaper(store, { title: '图注意力测试', text: body('图注意力网络'), year: 2024 })
  check('别名也能命中', paper2.hits.some((hit) => hit.id === added.entry.id), paper2.hits.map((h) => h.id).join(','))

  console.log('\n[4] 口径版本变化让旧提及变「旧口径」')
  const state = buildState(store, { paperLimit: 100 })
  check('存在旧口径提及', state.staleMentions > 0, String(state.staleMentions))
  check('旧口径论文数 > 0', state.stalePapers > 0, String(state.stalePapers))
  check('state 里的 dictVersion 是当前版本', state.dictVersion === dictVersionOf(store), state.dictVersion)

  console.log('\n[5] 重算能把旧口径刷掉')
  const reextract = buildReextractTool(getStore)
  const dry = await reextract.execute({ scope: 'stale' })
  check('预览有变化', dry.changed > 0, String(dry.changed))
  check('预览没写库', buildState(store, {}).staleMentions === state.staleMentions)
  const applied = await reextract.execute({ scope: 'stale', dryRun: false })
  check('执行后 changed > 0', applied.changed > 0, String(applied.changed))
  const after = buildState(store, { paperLimit: 100 })
  check('旧口径提及归零', after.staleMentions === 0, String(after.staleMentions))

  console.log('\n[6] 删除与别名搬移需要审批')
  const declining = buildDictionaryTool(getStore, { get: () => ({ request: async () => 'rejected' }) })
  let rejected = null
  try {
    await declining.execute({ action: 'remove', id: added.entry.id }, exec)
  } catch (error) {
    rejected = error
  }
  check('被拒绝时抛 APPROVAL_UNAVAILABLE', rejected?.code === 'APPROVAL_UNAVAILABLE', String(rejected?.code))
  check('被拒绝时条目还在', store.algorithms.has(added.entry.id))

  console.log('\n[7] 删除内置条目是软删除')
  const removedSeed = await tool.execute({ action: 'remove', id: 'crf' }, exec)
  check('soft=true', removedSeed.soft === true, JSON.stringify(removedSeed))
  check('条目仍在快照里', store.algorithms.has('crf'))
  check('状态标成 disabled', store.algorithms.get('crf')?.status === 'disabled')
  const viewAfter = buildDictionaryView(store)
  check('disabledCount 计到 1', viewAfter.disabledCount === 1, String(viewAfter.disabledCount))

  // 被禁用的词不再命中
  const paper3 = await ingestPaper(store, { title: '禁用词测试', text: body('命名实体识别') })
  check('禁用的 CRF 不再命中', !paper3.hits.some((hit) => hit.id === 'crf'), paper3.hits.map((h) => h.id).join(','))

  console.log('\n[8] 别名搬移（合并 / 拆分）')
  const move = await tool.execute({ action: 'moveAlias', alias: '图注意力', from: added.entry.id, to: 'attention' }, exec)
  check('搬到 attention', move.to === 'attention', JSON.stringify(move))
  check('来源里没有了', !(store.algorithms.get(added.entry.id).aliases ?? []).includes('图注意力'))
  check('目标里有', (store.algorithms.get('attention').aliases ?? []).includes('图注意力'))
  const split = await tool.execute({ action: 'moveAlias', alias: '图注意力', from: 'attention', to: '' }, exec)
  check('拆分（to 留空）只删不加', split.to === null && !(store.algorithms.get('attention').aliases ?? []).includes('图注意力'))

  console.log('\n[9] 自定义条目可硬删除')
  const hard = await tool.execute({ action: 'remove', id: added.entry.id }, exec)
  check('soft=false', hard.soft === false, JSON.stringify(hard))
  check('条目被删掉', !store.algorithms.has(added.entry.id))

  console.log('\n[10] 错误路径')
  let dup = null
  try {
    await tool.execute({ action: 'add', id: 'lstm', name: '重复' })
  } catch (error) {
    dup = error
  }
  check('重复 id 报错', String(dup?.message ?? '').includes('已存在'), String(dup?.message))
  let noName = null
  try {
    await tool.execute({ action: 'add', name: '' })
  } catch (error) {
    noName = error
  }
  check('缺名字报错', String(noName?.message ?? '').includes('缺少算法名'))
  let badAction = null
  try {
    await tool.execute({ action: 'what' })
  } catch (error) {
    badAction = error
  }
  check('未知 action → VALIDATION', badAction?.code === 'VALIDATION', String(badAction?.code))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
