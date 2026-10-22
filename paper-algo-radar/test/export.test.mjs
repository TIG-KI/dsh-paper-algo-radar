/**
 * T-10 验收：radar_export（§7 FR-7.3 / §8 R12）。
 *
 * 关键不变量：**落盘 + 只返回路径**，内容绝不进上下文。
 * 运行：node test/export.test.mjs
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, buildExportTool } = __test

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

const BODY =
  '摘　要：本文研究命名实体识别。方法上使用 LSTM 与 CRF，并以 Adam 优化；' +
  '实验部分与 SVM、随机森林、CNN 基线对比，评价指标为 F1。' +
  '结论部分总结了贡献，并指出未来工作将扩展到跨语言场景与低资源条件。' +
  '我们还报告了消融实验：去掉 CRF 后 F1 下降约百分之四，去掉 LSTM 后下降约百分之七。' +
  '所有实验在同一台机器上以相同的随机种子重复三次，报告均值与标准差；' +
  '训练使用早停策略，验证集与测试集严格分离，标签体系遵循 CoNLL-2003 的 BMES 标注。' +
  '在低资源设定下，我们进一步把训练语料缩减到原来的十分之一，观察各基线的退化曲线。' +
  '最后我们公开了预处理脚本与超参数配置，便于在同一数据划分上复现本文的所有数字。'

// 插件的门槛是 300 code point；这里留的余量很小，所以先自检
if (BODY.length < 300) throw new Error('测试正文太短：' + BODY.length)

const dir = await mkdtemp(join(tmpdir(), 'radar-export-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
const getStore = async () => store

try {
  const added = await ingestPaper(store, { title: '导出测试论文', text: BODY, year: 2024, fields: 'NLP' })
  check('准备：登记成功', added.created === true)

  const exporter = buildExportTool(getStore)

  console.log('\n[1] JSON 导出')
  const json = await exporter.execute({ format: 'json' })
  check('返回路径', typeof json.path === 'string' && json.path.endsWith('.json'))
  check('返回体积 > 0', json.bytes > 0, String(json.bytes))
  check('返回论文数', json.papers === 1, String(json.papers))
  check('默认 includeText=0', json.includeText === 0)
  check('返回值里没有正文', !JSON.stringify(json).includes('命名实体识别'), JSON.stringify(json).slice(0, 120))

  const raw = await readFile(json.path, 'utf8')
  const dump = JSON.parse(raw)
  check('文件可解析', typeof dump === 'object')
  check('带 schemaVersion', dump.schemaVersion === 2, String(dump.schemaVersion))
  check('带 dictVersion', typeof dump.dictVersion === 'string' && dump.dictVersion.length > 0)
  check('带论文 / 算法 / 提及', Array.isArray(dump.papers) && Array.isArray(dump.algorithms) && Array.isArray(dump.mentions))
  check('带三键', Array.isArray(dump.paperKeys) && dump.paperKeys.length >= 1, String(dump.paperKeys?.length))
  check('文件里确实有论文标题', raw.includes('导出测试论文'))

  console.log('\n[2] CSV 导出')
  const csv = await exporter.execute({ format: 'csv' })
  check('返回 .csv 路径', csv.path.endsWith('.csv'))
  const csvText = await readFile(csv.path, 'utf8')
  check('带 BOM（Excel 中文不乱码）', csvText.charCodeAt(0) === 0xfeff, String(csvText.charCodeAt(0)))
  const lines = csvText.replace(/^\ufeff/, '').trim().split('\n')
  check('首行是表头', lines[0].startsWith('rank,name,type,family,papers,mentions,coverage'), lines[0])
  check('每个算法一行', lines.length >= 2, String(lines.length))
  check('覆盖率带 %', lines[1].includes('%'), lines[1])

  console.log('\n[3] includeText 语义（W1.0：正文已留存）')
  const withText = await exporter.execute({ format: 'json', includeText: 1 })
  check('接受 includeText=1', withText.includeText === 1)
  check('有留存正文时 hasTextIncluded=true', withText.hasTextIncluded === true, String(withText.hasTextIncluded))
  const dumpWith = JSON.parse(await readFile(withText.path, 'utf8'))
  check('导出带 texts 数组', Array.isArray(dumpWith.texts) && dumpWith.texts.length === 1, JSON.stringify(dumpWith.texts))
  const card = exporter.output.render({}, withText).map((b) => b.text).join('\n')
  check('卡片给出体积与路径', card.includes('已导出') && card.includes('KB') && card.includes('路径'), card)
  check('卡片不再提示「正文未落地」', !card.includes('W1.0'), card)

  const noText = await exporter.execute({ format: 'json', includeText: 0 })
  const dumpNo = JSON.parse(await readFile(noText.path, 'utf8'))
  check('includeText=0 时没有 texts 字段', dumpNo.texts === undefined, JSON.stringify(Object.keys(dumpNo)))
  check('includeText=0 时返回值也没有正文', !JSON.stringify(noText).includes('命名实体识别'))

  console.log('\n[4] 导出目录与幂等')
  const files = await readdir(join(dir, 'exports'))
  check('文件落在 exports/ 下', files.length >= 2, files.join(','))
  check('导出不写 store.json 的备份', !files.some((f) => f.endsWith('.bak')))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
