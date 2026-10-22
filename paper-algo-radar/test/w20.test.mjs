/**
 * W2.0 验收：正文读取开关（E23）+ 每日自动备份（FR-7.6）。
 *
 * 运行：node test/w20.test.mjs
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, apply } = await import('../lib/index.js')
const { Store, ingestPaper, readRetainedText } = __test
const { BACKUP_KEEP, backupDir, backupStatus, maybeDailyBackup } = await import('../lib/backup.js')

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

function fakeCtx() {
  const tools = new Map()
  return {
    _tools: tools,
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get: (name) => tools.get(name),
    },
    effect(fn) {
      const d = fn()
      return () => d && d()
    },
    inject: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'radar-w20-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = dir

try {
  console.log('\n[1] textReadEnabled 默认关闭 → 工具不注册（E23）')
  {
    const ctx = fakeCtx()
    await apply(ctx, {})
    check('radar_text 未注册', ctx._tools.get('radar_text') === undefined)
    const status = await ctx._tools.get('radar_status').execute()
    check('capabilities.textRead=false', status.capabilities?.textRead === false, JSON.stringify(status.capabilities))
  }

  console.log('\n[2] 打开后才注册')
  {
    const ctx = fakeCtx()
    await apply(ctx, { textReadEnabled: true })
    check('radar_text 已注册', ctx._tools.get('radar_text') !== undefined)
    const status = await ctx._tools.get('radar_status').execute()
    check('capabilities.textRead=true', status.capabilities?.textRead === true)
  }

  console.log('\n[3] radar_text 的读取行为')
  {
    const store = new Store(join(dir, 'read.json'))
    await store.load()
    const added = await ingestPaper(store, { title: '正文读取测试', text: body('命名实体识别'), year: 2024 })
    const paperId = added.paper.id

    const first = await readRetainedText(store, paperId)
    check('返回 textIncluded=true', first.textIncluded === true)
    check('带 totalLength', first.totalLength > 300, String(first.totalLength))
    check('默认不超过 8000 字符', first.length <= 8000, String(first.length))
    check('正文确实是留存的那份', first.text.includes('命名实体识别'))

    const tiny = await readRetainedText(store, paperId, { limit: 50 })
    check('limit=50 生效', tiny.length === 50, String(tiny.length))
    check('truncated=true', tiny.truncated === true)
    check('offset 生效', (await readRetainedText(store, paperId, { offset: 10, limit: 20 })).offset === 10)

    let missing = null
    try {
      await readRetainedText(store, 'p_ffffffffffffffff')
    } catch (error) {
      missing = error
    }
    check('不存在的论文 → NOT_FOUND', missing?.code === 'NOT_FOUND', String(missing?.code))

    // 造一篇没有正文的
    store.papers.set('p_1111111111111111', { id: 'p_1111111111111111', title: '无正文', hasText: false })
    let noText = null
    try {
      await readRetainedText(store, 'p_1111111111111111')
    } catch (error) {
      noText = error
    }
    check('没有正文 → NOT_FOUND 且说明原因', noText?.code === 'NOT_FOUND' && String(noText.message).includes('没有留存正文'), String(noText?.message))
  }

  console.log('\n[4] 每日备份')
  {
    const store = new Store(join(dir, 'backup.json'))
    await store.load()
    await ingestPaper(store, { title: '备份测试', text: body('时序预测') })

    const day1 = new Date('2026-10-20T10:00:00')
    const first = await maybeDailyBackup(store, { now: () => day1.getTime(), schemaVersion: 2, dictVersion: '2026.10.1' })
    check('第一次创建了备份', first.created === true, JSON.stringify(first))
    const files1 = await readdir(backupDir(store.file))
    check('文件名按日期', files1.includes('radar-20261020.json'), files1.join(','))

    const again = await maybeDailyBackup(store, { now: () => day1.getTime() + 3600_000, schemaVersion: 2 })
    check('同一天不重复备份', again.created === false, JSON.stringify(again))

    const day2 = await maybeDailyBackup(store, { now: () => new Date('2026-10-21T09:00:00').getTime(), schemaVersion: 2 })
    check('第二天再备份一份', day2.created === true)
    const files2 = await readdir(backupDir(store.file))
    check('现在有 2 份', files2.filter((f) => /^radar-\d{8}\.json$/.test(f)).length === 2, files2.join(','))

    // 连续 10 天，只保留 7 份
    for (let day = 22; day <= 31; day += 1) {
      await maybeDailyBackup(store, { now: () => new Date(`2026-10-${day}T09:00:00`).getTime(), schemaVersion: 2 })
    }
    const kept = (await readdir(backupDir(store.file))).filter((f) => /^radar-\d{8}\.json$/.test(f)).sort()
    check(`只保留 ${BACKUP_KEEP} 份`, kept.length === BACKUP_KEEP, kept.join(','))
    check('留下的是最近的', kept[kept.length - 1] === 'radar-20261031.json', kept[kept.length - 1])
    check('最老的已被清掉', !kept.includes('radar-20261020.json'), kept.join(','))

    const status = await backupStatus(store)
    check('备份状态里有 latest', status.latest === 'radar-20261031.json', String(status.latest))
    check('备份状态里有 keep', status.keep === BACKUP_KEEP)
  }

  console.log('\n[5] 备份内容是结构化快照且不含正文文本')
  {
    const store = new Store(join(dir, 'backup2.json'))
    await store.load()
    await ingestPaper(store, { title: '快照测试', text: body('图学习'), year: 2023 })
    const result = await maybeDailyBackup(store, { now: () => new Date('2026-11-01T09:00:00').getTime(), schemaVersion: 2 })
    const { readFile } = await import('node:fs/promises')
    const dump = JSON.parse(await readFile(result.file, 'utf8'))
    check('带 schemaVersion', dump.schemaVersion === 2, String(dump.schemaVersion))
    check('带论文与提及', Array.isArray(dump.papers) && Array.isArray(dump.mentions))
    check('带三键', Array.isArray(dump.paperKeys))
    check('不含整段正文', !JSON.stringify(dump).includes(FILLER), '备份里出现了正文段落')
    check('论文行带 hasText 标记（正文在 texts/ 下）', dump.papers[0].hasText === true)
  }

  console.log('\n[6] 状态里能看到备份信息')
  {
    const store = new Store(join(dir, 'backup3.json'))
    await store.load()
    await maybeDailyBackup(store, { now: () => Date.now(), schemaVersion: 2 })
    const status = await backupStatus(store)
    check('count ≥ 1', status.count >= 1, String(status.count))
    check('dir 指向 backups/', status.dir.endsWith('backups'), status.dir)
  }
  console.log('\n[7] 首次激活引导（FR-11.3，面板内一次性）')
  {
    const withGuide = fakeCtx()
    await apply(withGuide, {})
    const statusOn = await withGuide._tools.get('radar_status').execute()
    check('默认开启引导', statusOn.guide?.enabled === true, JSON.stringify(statusOn.guide))

    const noGuide = fakeCtx()
    await apply(noGuide, { welcomeGuide: false })
    const statusOff = await noGuide._tools.get('radar_status').execute()
    check('welcomeGuide:false 关掉引导', statusOff.guide?.enabled === false, JSON.stringify(statusOff.guide))

    // 关闭一次之后 dismissed 落库
    const store = new Store(join(dir, 'guide.json'))
    await store.load()
    store.meta.set('guide', { key: 'guide', dismissed: true, dismissedAt: Date.now() })
    await store.save()
    const reopened = new Store(join(dir, 'guide.json'))
    await reopened.load()
    check('dismissed 标记能持久化', reopened.meta.get('guide')?.dismissed === true)
  }
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
