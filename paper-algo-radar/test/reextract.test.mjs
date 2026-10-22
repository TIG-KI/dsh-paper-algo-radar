/**
 * W1.0 验收：正文留存（§8 R11）+ 原地重算（FR-2.9）。
 *
 * 运行：node test/reextract.test.mjs
 */
import { mkdtemp, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, removePaper, buildReextractTool, buildExportTool, DICT_VERSION } = __test

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

const BODY_BASE =
  '摘　要：本文研究命名实体识别。方法上使用 LSTM 与 CRF，并以 Adam 优化。' +
  '实验与 SVM、随机森林、CNN 基线对比，指标为 F1，并报告消融：去掉 CRF 后下降约百分之四。' +
  '结论总结贡献，指出未来扩展到跨语言与低资源场景，并公开预处理脚本与超参数配置。'
const FILLER = '补充说明用于满足最小正文长度，不引入额外方法名称。'
let text = BODY_BASE
while (text.length < 340) text += FILLER
const BODY = text

const dir = await mkdtemp(join(tmpdir(), 'radar-reextract-'))
const storeFile = join(dir, 'store.json')
const store = new Store(storeFile)
await store.load()
const getStore = async () => store

try {
  console.log('\n[1] 登记即留存正文')
  const added = await ingestPaper(store, { title: '重算测试论文', text: BODY, year: 2024 })
  const paperId = added.paper.id
  const textsFiles = await readdir(join(dir, 'texts'))
  check('texts/ 下有这篇的 .txt.gz', textsFiles.includes(`${paperId}.txt.gz`), textsFiles.join(','))
  const paper = store.papers.get(paperId)
  check('hasText=true', paper.hasText === true)
  check('rawChars = 正文 code point 数', paper.rawChars === [...BODY].length, `${paper.rawChars} vs ${[...BODY].length}`)
  check('textHash 是 16 位', typeof paper.textHash === 'string' && paper.textHash.length === 16, paper.textHash)

  const gzStat = await stat(join(dir, 'texts', `${paperId}.txt.gz`))
  check('文件确实是压缩的（明显小于原文）', gzStat.size < Buffer.byteLength(BODY, 'utf8'), `${gzStat.size} vs ${Buffer.byteLength(BODY, 'utf8')}`)

  console.log('\n[2] 读回正文')
  const { readText } = __test
  const { normalizeText } = await import('../lib/extract.js')
  const restored = await readText(storeFile, paperId)
  // 留存的是 R1 规范化后的文本（全角空格会被 NFKC 折叠），不是原始字节
  check('读回内容 = R1 规范化后的原文', restored === normalizeText(BODY))
  check('规范化确实改了东西（全角空格）', normalizeText(BODY) !== BODY)
  check('读不存在的论文返回 null', (await readText(storeFile, 'p_ffffffffffffffff')) === null)

  console.log('\n[3] 重算：dryRun 默认只预览')
  // 造出「旧口径 + 一个已不在词典里的算法」
  const prefix = `${paperId}::`
  for (const [key, mention] of store.mentions) {
    if (mention.paperId === paperId) store.mentions.set(key, { ...mention, dictVersion: 'v0.2-legacy' })
  }
  store.mentions.set(prefix + 'ghost', {
    paperId,
    algorithmId: 'ghost',
    count: 5,
    sections: { method: 5 },
    snippets: [],
    role: null,
    dictVersion: 'v0.2-legacy',
    updatedAt: 1,
  })
  const beforeCount = store.mentions.size

  const tool = buildReextractTool(getStore)
  const preview = await tool.execute({ scope: 'stale' })
  check('默认 dryRun=true', preview.dryRun === true)
  check('total=1（只有这篇是旧口径）', preview.total === 1, String(preview.total))
  check('changed=1', preview.changed === 1, String(preview.changed))
  check('diff 指出 ghost 会被移除', (preview.diff[0]?.removed ?? []).includes('ghost'), JSON.stringify(preview.diff[0]))
  check('预览不改库（提及数不变）', store.mentions.size === beforeCount, `${store.mentions.size} vs ${beforeCount}`)
  check('预览后提及仍是旧口径', [...store.mentions.values()].every((m) => m.dictVersion === 'v0.2-legacy'))

  console.log('\n[4] 重算：显式 dryRun=false 才写库')
  const applied = await tool.execute({ scope: 'stale', dryRun: false })
  check('dryRun=false', applied.dryRun === false)
  check('ghost 已被移除', !store.mentions.has(prefix + 'ghost'))
  check('全部提及换成当前口径', [...store.mentions.values()].every((m) => m.dictVersion === DICT_VERSION))
  check('提及数与重抽结果一致', store.mentions.size === added.total, `${store.mentions.size} vs ${added.total}`)
  check('paper.hitCount 已刷新', store.papers.get(paperId).hitCount === added.total)

  const stateAfter = __test.buildState(store, { paperLimit: 0 })
  check('重算后 staleMentions 归零', stateAfter.staleMentions === 0, String(stateAfter.staleMentions))

  console.log('\n[5] 没有正文的论文会被跳过')
  await unlink(join(dir, 'texts', `${paperId}.txt.gz`))
  const store2 = new Store(storeFile)
  await store2.load()
  const paper2 = store2.papers.get(paperId)
  check('快照里 hasText 仍为 true（文件被手动删了）', paper2?.hasText === true)
  const applied2 = await buildReextractTool(async () => store2).execute({ scope: 'all', dryRun: false })
  check('skippedNoText=1', applied2.skippedNoText === 1, String(applied2.skippedNoText))
  check('total 仍计入了这篇', applied2.total === 1, String(applied2.total))

  console.log('\n[6] 删除论文连带删正文')
  const store3 = new Store(storeFile)
  await store3.load()
  const added2 = await ingestPaper(store3, { title: '删除测试', text: BODY })
  const file2 = join(dir, 'texts', `${added2.paper.id}.txt.gz`)
  check('先确认正文存在', (await stat(file2)).size > 0)
  await removePaper(store3, added2.paper.id)
  let gone = false
  try {
    await stat(file2)
  } catch {
    gone = true
  }
  check('删论文后正文文件不在了', gone)

  console.log('\n[7] 导出 includeText 的诚实回报')
  const exp = await buildExportTool(getStore).execute({ format: 'json', includeText: 1 })
  check('有正文时 hasTextIncluded=true', exp.hasTextIncluded === true, JSON.stringify(exp))
  const dump = JSON.parse(await readFile(exp.path, 'utf8'))
  check('导出里带 texts 数组', Array.isArray(dump.texts) && dump.texts.length >= 1)
  // 正文本身不该出现，但证据片段（≤200 cp，R7 允许）里出现原文是正常的
  check('texts 条目只有 id 与 hash、没有正文', dump.texts.every((t) => !('text' in t) && typeof t.textHash === 'string'))
  check('导出里没有整段正文（用补齐句作探针）', !JSON.stringify(dump).includes(FILLER), '导出体里出现了完整正文段落')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
