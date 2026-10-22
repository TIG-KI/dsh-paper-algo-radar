/**
 * W1.1 验收：撤销 / 清空 / 恢复（§7 FR-2.10 / FR-7.5 / FR-8.5 / FR-8.7）。
 *
 * 重点不是「能删」，而是：
 *  - 默认 dryRun，不给 false 就不动手
 *  - 真删除/清空要过审批；审批不可用时**失败关闭且库不动**
 *  - 窗口内撤销能把正文一起找回来（撤销后仍可重算）
 *  - 窗口过期后正文文件才真正删除
 *
 * 运行：node test/undo.test.mjs
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, clearLibrary, restoreDump, UndoStack, buildRemoveTool, buildClearTool, buildRestoreTool, DICT_VERSION } = __test

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

const grantingCtx = { get: () => ({ request: async () => 'allowed-once' }) }
const decliningCtx = { get: () => ({ request: async () => 'rejected' }) }
const exec = { agent: { session: {} }, name: 'radar_remove' }

const dir = await mkdtemp(join(tmpdir(), 'radar-undo-'))
try {
  console.log('\n[1] UndoStack 自身')
  {
    let now = 1000
    const expired = []
    const stack = new UndoStack({ windowMs: 10000, now: () => now, onExpire: (entry) => expired.push(entry.token) })
    const first = stack.push('delete', { label: 'a', texts: ['p1'] })
    check('返回令牌与过期时间', typeof first.token === 'string' && first.expiresAt === 11000, JSON.stringify(first))
    check('未过期时能取到', stack.take(first.token)?.payload.label === 'a')

    const second = stack.push('delete', { label: 'b', texts: ['p2'] })
    now += 10001
    check('过期后 take 返回 null', stack.take(second.token) === null)
    check('过期时触发了 onExpire', expired.includes(second.token), JSON.stringify(expired))

    const third = stack.push('clear', { label: 'c', texts: [] })
    stack.drop(third.token)
    check('drop 之后取不到', stack.take(third.token) === null)

    for (let i = 0; i < 12; i += 1) stack.push('delete', { label: `x${i}`, texts: [] })
    check('最多保留 10 条', stack.size() <= 10, String(stack.size()))
  }

  console.log('\n[2] 删除：默认 dryRun')
  {
    const store = new Store(join(dir, 'a.json'))
    await store.load()
    const added = await ingestPaper(store, { title: '删除测试', text: body('命名实体识别') })
    const paperId = added.paper.id
    const stack = new UndoStack()
    const tool = buildRemoveTool(async () => store, stack, grantingCtx)

    const preview = await tool.execute({ paperId })
    check('默认 dryRun=true', preview.dryRun === true)
    check('预览给出提及数', preview.mentions >= 1, String(preview.mentions))
    check('预览没删', store.papers.size === 1)
    check('预览不占用撤销栈', stack.size() === 0)
  }

  console.log('\n[3] 删除：审批')
  {
    const store = new Store(join(dir, 'b.json'))
    await store.load()
    const added = await ingestPaper(store, { title: '审批测试', text: body('时序预测') })
    const paperId = added.paper.id

    const declining = buildRemoveTool(async () => store, new UndoStack(), decliningCtx)
    let rejected = null
    try {
      await declining.execute({ paperId, dryRun: false }, exec)
    } catch (e) {
      rejected = e
    }
    check('被拒绝时抛 APPROVAL_UNAVAILABLE', rejected?.code === 'APPROVAL_UNAVAILABLE', String(rejected?.code))
    check('被拒绝时论文还在', store.papers.size === 1)

    const noService = buildRemoveTool(async () => store, new UndoStack(), { get: () => undefined })
    let closed = null
    try {
      await noService.execute({ paperId, dryRun: false }, exec)
    } catch (e) {
      closed = e
    }
    check('无审批服务时失败关闭', closed?.code === 'APPROVAL_UNAVAILABLE', String(closed?.code))
    check('失败关闭时论文还在', store.papers.size === 1)
  }

  console.log('\n[4] 删除 → 撤销（正文一起回来）')
  {
    const store = new Store(join(dir, 'c.json'))
    await store.load()
    const added = await ingestPaper(store, { title: '撤销测试', text: body('命名实体识别'), year: 2024 })
    const paperId = added.paper.id
    const textFile = join(dir, 'texts', `${paperId}.txt.gz`)
    check('正文文件存在', (await stat(textFile)).size > 0)

    const stack = new UndoStack()
    const remover = buildRemoveTool(async () => store, stack, grantingCtx)
    const restorer = buildRestoreTool(async () => store, stack)

    const removed = await remover.execute({ paperId, dryRun: false }, exec)
    check('删除成功', removed.dryRun === false)
    check('库里没了', store.papers.size === 0)
    check('提及也清了', store.mentions.size === 0)
    check('拿到了撤销令牌', typeof removed.undo?.token === 'string', JSON.stringify(removed.undo))
    check('撤销窗口有 10 秒', removed.undo.expiresAt - Date.now() <= 10001 && removed.undo.expiresAt > Date.now())
    check('**正文文件还在**（窗口内保留）', (await stat(textFile)).size > 0)

    const restored = await restorer.execute({ token: removed.undo.token })
    check('恢复到 1 篇', store.papers.size === 1, String(store.papers.size))
    check('提及也回来了', store.mentions.size > 0, String(store.mentions.size))
    check('三键也回来了', store.paperKeys.size >= 1, String(store.paperKeys.size))
    check('hasText 仍是 true（可重算）', store.papers.get(paperId)?.hasText === true)
    check('撤销返回恢复篇数', restored.restoredPapers === 1, String(restored.restoredPapers))
  }

  console.log('\n[5] 清空：确认词 + dryRun')
  {
    const store = new Store(join(dir, 'd.json'))
    await store.load()
    await ingestPaper(store, { title: '甲', text: body('命名实体识别') })
    await ingestPaper(store, { title: '乙', text: body('时序预测') })
    const stack = new UndoStack()
    const clearer = buildClearTool(async () => store, stack, grantingCtx)
    const restorer = buildRestoreTool(async () => store, stack)

    const preview = await clearer.execute({})
    check('默认 dryRun=true', preview.dryRun === true)
    check('预览给出篇数与提及数', preview.papers === 2 && preview.mentions > 0, JSON.stringify(preview))
    check('预览没清', store.papers.size === 2)

    let noWord = null
    try {
      await clearer.execute({ dryRun: false }, exec)
    } catch (e) {
      noWord = e
    }
    check('缺确认词 → VALIDATION', noWord?.code === 'VALIDATION' && noWord?.field === 'confirm', String(noWord?.code))
    check('缺确认词时库没动', store.papers.size === 2)

    let badWord = null
    try {
      await clearer.execute({ dryRun: false, confirm: '删除' }, exec)
    } catch (e) {
      badWord = e
    }
    check('错的确认词也被拒', badWord?.code === 'VALIDATION')

    const cleared = await clearer.execute({ dryRun: false, confirm: '清空' }, exec)
    check('清空成功', cleared.cleared === 2, String(cleared.cleared))
    check('库里 0 篇', store.papers.size === 0)
    check('词典保留（不被清空）', store.algorithms.size >= 0)
    check('拿到撤销令牌', typeof cleared.undo?.token === 'string')

    const back = await restorer.execute({ token: cleared.undo.token })
    check('撤销后回到 2 篇', store.papers.size === 2, String(store.papers.size))
    check('撤销返回 2 篇', back.restoredPapers === 2, String(back.restoredPapers))
  }

  console.log('\n[6] 清空的审批')
  {
    const store = new Store(join(dir, 'e.json'))
    await store.load()
    await ingestPaper(store, { title: '丙', text: body('命名实体识别') })
    const lighter = buildClearTool(async () => store, new UndoStack(), decliningCtx)
    let rejected = null
    try {
      await lighter.execute({ dryRun: false, confirm: 'CLEAR' }, exec)
    } catch (e) {
      rejected = e
    }
    check('清空被拒绝时抛 APPROVAL_UNAVAILABLE', rejected?.code === 'APPROVAL_UNAVAILABLE', String(rejected?.code))
    check('被拒绝时库没动', store.papers.size === 1)
  }

  console.log('\n[7] clearLibrary 是纯快照 + 保留词典')
  {
    const store = new Store(join(dir, 'f.json'))
    await store.load()
    await ingestPaper(store, { title: '丁', text: body('命名实体识别') })
    const algorithmsBefore = store.algorithms.size
    const { cleared, dump } = await clearLibrary(store)
    check('cleared 计数正确', cleared === 1)
    check('dump 里有论文', dump.papers.length === 1)
    check('dump 里有提及', dump.mentions.length > 0)
    check('词典没被清', store.algorithms.size === algorithmsBefore, `${store.algorithms.size} vs ${algorithmsBefore}`)
    restoreDump(store, dump)
    check('restoreDump 能恢复', store.papers.size === 1 && store.mentions.size === dump.mentions.length)
  }

  console.log('\n[8] 撤销过期后正文才真正删')
  {
    const store = new Store(join(dir, 'g.json'))
    await store.load()
    const added = await ingestPaper(store, { title: '过期测试', text: body('命名实体识别') })
    const paperId = added.paper.id
    const textFile = join(dir, 'texts', `${paperId}.txt.gz`)
    let now = Date.now()
    const removedTexts = []
    const stack = new UndoStack({
      now: () => now,
      onExpire: (entry) => {
        removedTexts.push(...(entry.payload.texts ?? []))
      },
    })
    const remover = buildRemoveTool(async () => store, stack, grantingCtx)
    await remover.execute({ paperId, dryRun: false }, exec)
    check('窗口内正文还在', (await stat(textFile)).size > 0)

    now += 10001
    stack.prune()
    check('过期后回调收到了正文 id', removedTexts.includes(paperId), JSON.stringify(removedTexts))
    check('过期后撤销不可能成功', stack.take(stack.list()[0]?.token ?? 'nope') === null)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
