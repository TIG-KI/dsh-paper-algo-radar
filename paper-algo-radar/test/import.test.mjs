/**
 * W1.0 验收：radar_import（§7 FR-7.4 / E6 / E16）。
 *
 * 关键不变量：
 *  - dryRun 默认 true 且**结构上**不改库（planImport 只读，apply 才写）
 *  - merge 按三键去重，重复导入不会变两篇
 *  - overwrite 整体替换
 *  - 三种输入形态都能识别
 *
 * 运行：node test/import.test.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, buildImportTool, buildExportTool, buildState } = __test
const { detectSnapshotKind, normalizeSnapshot, planImport } = await import('../lib/importer.js')

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
const makeBody = (topic) => {
  let text = `摘　要：本文研究${topic}。方法上使用 LSTM 与 CRF，并以 Adam 优化，实验中与 SVM 对比。`
  while (text.length < 340) text += FILLER
  return text
}

const dir = await mkdtemp(join(tmpdir(), 'radar-import-'))
try {
  // ── 源库：两篇论文 → 导出 ─────────────────────────────
  const srcFile = join(dir, 'src.json')
  const src = new Store(srcFile)
  await src.load()
  const p1 = await ingestPaper(src, { title: '导入论文甲', text: makeBody('命名实体识别'), year: 2024, doi: '10.1000/a' })
  const p2 = await ingestPaper(src, { title: '导入论文乙', text: makeBody('空气质量预测'), year: 2023 })
  const exporter = buildExportTool(async () => src)
  const exported = await exporter.execute({ format: 'json' })

  console.log('\n[1] 形态识别')
  const { readFile } = await import('node:fs/promises')
  const exportRaw = JSON.parse(await readFile(exported.path, 'utf8'))
  check('导出文件识别为 export-v2', detectSnapshotKind(exportRaw) === 'export-v2', String(detectSnapshotKind(exportRaw)))

  const legacyRaw = {
    version: 1,
    papers: { p_0123456789abcdef: { id: 'p_0123456789abcdef', title: 'Legacy', chars: 5000, fields: ['x'] } },
    algorithms: {},
    mentions: { 'p_0123456789abcdef::lstm': { paperId: 'p_0123456789abcdef', algorithmId: 'lstm', count: 3 } },
    meta: {},
  }
  check('v0.2 文件识别为 v0.2', detectSnapshotKind(legacyRaw) === 'v0.2')
  check('乱七八糟的对象返回 null', detectSnapshotKind({ hello: 'world' }) === null)
  let kindError = null
  try {
    normalizeSnapshot({ hello: 'world' })
  } catch (e) {
    kindError = e
  }
  check('无法识别时抛 VALIDATION', kindError?.code === 'VALIDATION', String(kindError?.code))

  console.log('\n[2] 导入到空库（merge）')
  const targetFile = join(dir, 'target.json')
  const target = new Store(targetFile)
  await target.load()
  // 审批闸门：overwrite 真写库时要过宿主审批，这里给一个「一次性允许」的假审批
  const grantingCtx = { get: () => ({ request: async () => 'allowed-once' }) }
  const exec = { agent: { session: {} }, name: 'radar_import' }
  const importer = buildImportTool(async () => target, grantingCtx)

  const preview = await importer.execute({ path: exported.path })
  check('默认 dryRun=true', preview.dryRun === true)
  check('识别为 export-v2', preview.kind === 'export-v2', preview.kind)
  check('文件里 2 篇', preview.incomingPapers === 2, String(preview.incomingPapers))
  check('将新增 2 篇', preview.added === 2, String(preview.added))
  check('预览后目标库仍是空的', target.papers.size === 0, String(target.papers.size))

  const applied = await importer.execute({ path: exported.path, dryRun: false })
  check('applied=true', applied.applied === true)
  check('目标库有 2 篇', target.papers.size === 2, String(target.papers.size))
  check('提及也进来了', target.mentions.size === src.mentions.size, `${target.mentions.size} vs ${src.mentions.size}`)
  check('三键重建', target.paperKeys.size >= 2, String(target.paperKeys.size))
  check('本地 id 与源一致', target.papers.has(p1.paper.id) && target.papers.has(p2.paper.id))

  console.log('\n[3] 重复导入不产生重复（三键）')
  const again = await importer.execute({ path: exported.path, dryRun: false })
  check('第二次新增 0 篇', again.added === 0, String(again.added))
  check('第二次更新 2 篇', again.updated === 2, String(again.updated))
  check('目标库仍是 2 篇', target.papers.size === 2, String(target.papers.size))

  console.log('\n[4] 同一篇但换了 id → 靠 DOI 命中并记冲突')
  const variant = JSON.parse(await readFile(exported.path, 'utf8'))
  // 换 id、换标题，但保留 DOI —— doi 键应该命中已有记录，并记一条 id 冲突
  variant.papers = variant.papers.map((p) =>
    p.doi === '10.1000/a' ? { ...p, id: 'p_9999999999999999', title: '改过标题和 id 的甲' } : p
  )
  variant.mentions = variant.mentions.map((m) =>
    m.paperId === p1.paper.id ? { ...m, paperId: 'p_9999999999999999' } : m
  )
  const variantFile = join(dir, 'variant.json')
  await writeFile(variantFile, JSON.stringify(variant), 'utf8')
  const variantPreview = await importer.execute({ path: variantFile })
  check(
    '靠 doi 命中已有记录（不新增）',
    variantPreview.updated >= 1 && variantPreview.added === 0,
    JSON.stringify({ added: variantPreview.added, updated: variantPreview.updated })
  )
  check('记录了 id 冲突', variantPreview.conflicts.length >= 1, JSON.stringify(variantPreview.conflicts))
  check(
    '冲突里保留的是本地 id',
    variantPreview.conflicts[0]?.localId === p1.paper.id,
    JSON.stringify(variantPreview.conflicts[0])
  )

  console.log('\n[5] 导入 v0.2 文件')
  const legacyFile = join(dir, 'legacy.json')
  await writeFile(legacyFile, JSON.stringify(legacyRaw), 'utf8')
  const legacyPreview = await importer.execute({ path: legacyFile })
  check('识别为 v0.2', legacyPreview.kind === 'v0.2', legacyPreview.kind)
  check('预览将新增 1 篇', legacyPreview.added === 1, String(legacyPreview.added))
  const legacyApplied = await importer.execute({ path: legacyFile, dryRun: false })
  check('导入后共 3 篇', target.papers.size === 3, String(target.papers.size))
  const legacyPaper = target.papers.get('p_0123456789abcdef')
  check('v0.2 的 id 被沿用', legacyPaper !== undefined, [...target.papers.keys()].join(','))
  check('提及补了 dictVersion', target.mentions.get('p_0123456789abcdef::lstm')?.dictVersion === 'v0.2-legacy')

  console.log('\n[6] overwrite 整体替换')
  const beforeCount = target.papers.size
  const ow = await importer.execute({ path: exported.path, mode: 'overwrite', dryRun: false }, exec)
  check('overwrite 记录了替换数', ow.replaced === beforeCount, `${ow.replaced} vs ${beforeCount}`)
  check('库变成文件里的 2 篇', target.papers.size === 2, String(target.papers.size))
  check('v0.2 那篇被清掉了', !target.papers.has('p_0123456789abcdef'))

  console.log('\n[6b] overwrite 的审批闸门')
  // 预览不需要审批
  const owPreview = await importer.execute({ path: exported.path, mode: 'overwrite' })
  check('dryRun 的 overwrite 不要求审批', owPreview.dryRun === true && owPreview.replaced >= 0)

  // 拒绝：库必须原样
  const decliningCtx = { get: () => ({ request: async () => 'rejected' }) }
  const declining = buildImportTool(async () => target, decliningCtx)
  const countBefore = target.papers.size
  let declined = null
  try {
    await declining.execute({ path: exported.path, mode: 'overwrite', dryRun: false }, exec)
  } catch (e) {
    declined = e
  }
  check('被拒绝时抛 APPROVAL_UNAVAILABLE', declined?.code === 'APPROVAL_UNAVAILABLE', String(declined?.code))
  check('被拒绝时库没动', target.papers.size === countBefore, `${target.papers.size} vs ${countBefore}`)

  // 没有审批服务 → 失败关闭
  const noService = buildImportTool(async () => target, { get: () => undefined })
  let closed = null
  try {
    await noService.execute({ path: exported.path, mode: 'overwrite', dryRun: false }, exec)
  } catch (e) {
    closed = e
  }
  check('没有审批服务时失败关闭', closed?.code === 'APPROVAL_UNAVAILABLE', String(closed?.code))
  check('失败关闭时库没动', target.papers.size === countBefore)

  // 没有 agent → 失败关闭
  let noAgent = null
  try {
    await importer.execute({ path: exported.path, mode: 'overwrite', dryRun: false }, {})
  } catch (e) {
    noAgent = e
  }
  check('没有 agent 时失败关闭', noAgent?.code === 'APPROVAL_UNAVAILABLE', String(noAgent?.code))

  console.log('\n[7] 错误路径')
  let missing = null
  try {
    await importer.execute({ path: join(dir, 'nope.json') })
  } catch (e) {
    missing = e
  }
  check('文件不存在 → NOT_FOUND', missing?.code === 'NOT_FOUND', String(missing?.code))

  const badFile = join(dir, 'bad.json')
  await writeFile(badFile, '{ 不是 JSON', 'utf8')
  let bad = null
  try {
    await importer.execute({ path: badFile })
  } catch (e) {
    bad = e
  }
  check('坏 JSON → VALIDATION', bad?.code === 'VALIDATION', String(bad?.code))

  let noPath = null
  try {
    await importer.execute({})
  } catch (e) {
    noPath = e
  }
  check('缺 path → VALIDATION', noPath?.code === 'VALIDATION' && noPath?.field === 'path')

  console.log('\n[8] planImport 的纯只读性')
  const readonly = new Store(join(dir, 'ro.json'))
  await readonly.load()
  const before = { papers: readonly.papers.size, mentions: readonly.mentions.size, keys: readonly.paperKeys.size }
  const plan = planImport(readonly, exportRaw, { mode: 'merge', dryRun: true })
  check('planImport 没改 papers', readonly.papers.size === before.papers)
  check('planImport 没改 mentions', readonly.mentions.size === before.mentions)
  check('planImport 没改 keys', readonly.paperKeys.size === before.keys)
  check('planImport 返回了 apply', typeof plan.apply === 'function')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
