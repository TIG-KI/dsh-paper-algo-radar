/**
 * 缺省领域标签（fields）不能静默。
 *
 * 背景：2026-10-22 从 Zotero 批量登记 74 篇，全部走了手工逐条 `radar_add`，
 * 只给 pdfPath / title / venue / year / doi，没有 fields。结果每篇都被
 * ingestPaper 的兜底值打成了「未分类」，而调用方（我）从返回体里看不出来。
 *
 * 修法：缺省落点只有一处（ingestPaper）。这里钉住三条语义：
 *   1) 新论文没有 fields → 落「未分类」，返回体必须带 fields:未指定 告警；
 *   2) 已有领域的老论文再补登记（不带 fields）→ 沿用旧领域，不告警；
 *   3) 显式传 fields → 以传入值为准，不告警。
 *
 * 运行：node test/fields-default.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper } = __test

const BODY =
  '摘　要：本文研究时序预测问题，提出一种基于 LSTM 与 Transformer 的混合结构。' +
  '在方法部分，我们先用 LSTM 编码长程依赖，再用 Transformer 的注意力机制建模跨变量关系，' +
  '并以 Adam 作为优化器、以 KL 散度作为正则项。实验部分在三个公开数据集上与 SVM、随机森林、CNN 基线对比，' +
  '结果表明该结构在 RMSE 与 MAE 上均优于基线，且在不同预测步长下保持稳定。' +
  '此外我们还分析了注意力权重的分布，讨论了模型在小样本条件下的退化现象与改进方向。' +
  '结论部分总结了本文的贡献，并指出未来工作将扩展到多模态输入与在线学习场景。' +
  '在进一步的分析中，我们观察到当预测步长超过七十二小时之后，所有基线的误差都出现明显上升，' +
  '而混合结构因为同时具备循环编码与全局注意力，误差上升的幅度更小；我们推测这来自两方面的互补：' +
  '循环部分负责捕捉局部平滑趋势，注意力部分负责在长跨度上重新对齐相似的时段模式。' +
  '这一观察也解释了为什么在序列长度增加时，单纯增大循环层的效果会迅速饱和。'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'radar-fields-'))
const store = new Store(join(dir, 'store.json'))
await store.load()

try {
  console.log('\n[1] 新论文不传 fields')
  const first = await ingestPaper(store, { title: 'Unlabeled Paper A', text: BODY })
  check('落库为「未分类」', JSON.stringify(first.paper.fields) === JSON.stringify(['未分类']), JSON.stringify(first.paper.fields))
  check('返回体带 fields:未指定 告警', first.warnings.includes('fields:未指定'), JSON.stringify(first.warnings))

  console.log('\n[2] 已分类论文补登记（不带 fields）')
  const seeded = await ingestPaper(store, { title: 'Labeled Paper B', text: BODY, fields: '时序预测, Transformer' })
  check('首次登记写入领域', seeded.paper.fields.join(',') === '时序预测,Transformer', seeded.paper.fields.join(','))
  check('首次登记不告警', !seeded.warnings.includes('fields:未指定'), JSON.stringify(seeded.warnings))
  const again = await ingestPaper(store, { title: 'Labeled Paper B', text: BODY })
  check('补登记沿用旧领域', again.paper.fields.join(',') === '时序预测,Transformer', again.paper.fields.join(','))
  check('补登记不告警', !again.warnings.includes('fields:未指定'), JSON.stringify(again.warnings))

  console.log('\n[3] 显式传 fields')
  const explicit = await ingestPaper(store, { title: 'Explicit Paper C', text: BODY, fields: 'NLP' })
  check('以传入值为准', explicit.paper.fields.join(',') === 'NLP', explicit.paper.fields.join(','))
  check('显式传值不告警', !explicit.warnings.includes('fields:未指定'), JSON.stringify(explicit.warnings))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
