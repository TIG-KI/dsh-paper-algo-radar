import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test, generateReport } = await import('../../paper-algo-radar/lib/index.js')
const { Store, ingestPaper } = __test

const dir = await mkdtemp(join(tmpdir(), 'radar-smoke-'))
const store = new Store(join(dir, 'radar.json'))
await store.load()

const FILLER = '补充说明用于满足最小正文长度，不引入额外的方法名称。'
const makeBody = (topic, extra) => {
  let text = `摘　要：本文研究${topic}。${extra ?? ''}`
  while ([...text].length < 360) text += FILLER
  return text
}

const papers = [
  { title: '空气质量预测中的深度学习', year: 2019, fields: '空气质量', text: makeBody('空气质量预测', '方法使用 LSTM 与 CNN，优化器 Adam。') },
  { title: '空气污染时空建模', year: 2021, fields: '空气质量', text: makeBody('污染建模', '使用 LSTM、Transformer 与随机森林对比。') },
  { title: '命名实体识别综述', year: 2022, fields: 'NLP', text: makeBody('命名实体识别', '使用 CRF 与双向 LSTM，评估用 F1。') },
  { title: '小样本学习', year: 2024, fields: '小样本', text: makeBody('小样本分类', '使用 MLP 与 SVM 作为基线。') },
]
for (const paper of papers) {
  await ingestPaper(store, paper)
}
// 造一篇摘要级、一篇无正文，便于验证缺口规则与标记
await ingestPaper(store, { title: '摘要级论文', year: 2025, fields: '空气质量', text: '摘　要：摘要级输入，只给了摘要。方法提及 LSTM 与 Adam。'.padEnd(340, '补'), depth: 'abstract' })

const fixed = Date.parse('2026-10-23T00:28:00+08:00')
const review = await generateReport(store, { mode: 'review', generatedAt: new Date(fixed).toISOString(), referenceYear: 2026 })
console.log('== review ==')
console.log('path:', review.path)
console.log('bytes:', review.bytes, 'sections:', review.sections.length)
console.log('---')
console.log(await readFile(review.path, 'utf8'))

const decide = await generateReport(store, { mode: 'decide', generatedAt: new Date(fixed).toISOString(), referenceYear: 2026 })
console.log('\n== decide ==')
console.log('path:', decide.path, 'bytes:', decide.bytes)
console.log('---')
console.log(await readFile(decide.path, 'utf8'))

await rm(dir, { recursive: true, force: true })
