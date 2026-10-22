/**
 * T-02 验收：三键去重 + 原子写。
 *
 * 不依赖宿主：直接 import 插件模块，构造一个临时的 Store 跑真实登记流程。
 * 运行：node test/dedupe.test.mjs
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, removePaper, normalizeTitleKey, looksLikeArxiv, normalizeArxivId } = __test

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
  '这一观察也解释了为什么在序列长度增加时，单纯增大循环层的效果会迅速饱和。' +
  '最后我们给出复现实验所需的关键超参数与随机种子设置，便于后续工作直接对比。'

if (BODY.length < 320) throw new Error('测试正文太短：' + BODY.length)

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

const dir = await mkdtemp(join(tmpdir(), 'radar-t02-'))
const file = join(dir, 'store.json')

try {
  console.log('\n[1] 键的规范化')
  check('标题键对空白/大小写/全角不敏感', normalizeTitleKey('  Attention   is ALL  you need ') === normalizeTitleKey('attention is all you need'))
  check('识别裸 arXiv id', looksLikeArxiv('2006.11239'))
  check('识别 arXiv 链接', looksLikeArxiv('https://arxiv.org/abs/2006.11239'))
  check('不把普通 DOI 当 arXiv', !looksLikeArxiv('10.1109/CVPR.2016.90'))
  check('arXiv 链接去壳', normalizeArxivId('https://arxiv.org/pdf/2006.11239v2.pdf') === '2006.11239v2')

  console.log('\n[2] 首次登记')
  const store = new Store(file)
  await store.load()
  const first = await ingestPaper(store, {
    title: 'Hybrid LSTM-Transformer for Time Series',
    text: BODY,
    fields: '时序预测',
  })
  check('返回 created=true', first.created === true)
  check('id 形如 p_<16hex>', /^p_[0-9a-f]{16}$/.test(first.paper.id), first.paper.id)
  check('有标题键', store.paperKeys.has('title:' + normalizeTitleKey('Hybrid LSTM-Transformer for Time Series')))
  check('命中了算法', first.total > 0, 'total=' + first.total)
  const idA = first.paper.id

  console.log('\n[3] 补年份重复登记 → 同一篇（E10 核心）')
  const second = await ingestPaper(store, {
    title: 'Hybrid LSTM-Transformer for Time Series',
    text: BODY,
    year: 2024,
  })
  check('created=false', second.created === false)
  check('id 不变', second.paper.id === idA, `${second.paper.id} vs ${idA}`)
  check('年份被更新', second.paper.year === 2024, String(second.paper.year))
  check('论文数仍是 1', store.papers.size === 1, String(store.papers.size))

  console.log('\n[4] 补 DOI 重复登记 → 同一篇，并补齐 doi 键')
  const third = await ingestPaper(store, {
    title: 'Hybrid LSTM-Transformer for Time Series',
    text: BODY,
    doi: '10.1234/abc.2024',
    year: 2024,
  })
  check('created=false', third.created === false)
  check('id 不变', third.paper.id === idA)
  check('doi 键已挂上', store.paperKeys.get('doi:10.1234/abc.2024') === idA)
  check('dedupeKey 变成 doi:', third.paper.dedupeKey === 'doi:10.1234/abc.2024', third.paper.dedupeKey)

  console.log('\n[5] 只给 DOI、标题不同 → 仍是同一篇')
  const fourth = await ingestPaper(store, {
    title: 'A Slightly Different Title',
    text: BODY,
    doi: 'https://doi.org/10.1234/ABC.2024',
  })
  check('created=false', fourth.created === false)
  check('id 不变', fourth.paper.id === idA)
  check('论文数仍是 1', store.papers.size === 1)

  console.log('\n[6] arXiv 通道')
  const fifth = await ingestPaper(store, {
    title: 'Some arXiv Paper',
    text: BODY,
    doi: 'https://arxiv.org/abs/1706.03762v5',
  })
  check('created=true（新论文）', fifth.created === true)
  check('arxiv 键已挂上', store.paperKeys.get('arxiv:1706.03762v5') === fifth.paper.id)
  check('doi 没有被写成 arXiv id', (store.papers.get(fifth.paper.id).doi ?? '') === '')
  const sixth = await ingestPaper(store, {
    title: 'Some arXiv Paper (preprint)',
    text: BODY,
    arxivId: '1706.03762v5',
  })
  check('arxivId 命中同一篇', sixth.paper.id === fifth.paper.id)
  check('论文数仍是 2', store.papers.size === 2, String(store.papers.size))

  console.log('\n[7] 删除要同时清键')
  const removed = await removePaper(store, idA)
  check('existed=true', removed.existed === true)
  check('清了 2 个键（doi + title）', removed.removedKeys === 2, String(removed.removedKeys))
  check('doi 键没了', !store.paperKeys.has('doi:10.1234/abc.2024'))
  const afterRemove = await ingestPaper(store, {
    title: 'Hybrid LSTM-Transformer for Time Series',
    text: BODY,
    doi: '10.1234/abc.2024',
  })
  check('删掉后重新登记是"新建"', afterRemove.created === true)

  console.log('\n[8] 原子写与备份')
  const files = await readdir(dir)
  check('没有残留 .tmp', files.every((f) => !f.endsWith('.tmp')), files.join(','))
  check('存在 store.json.bak', files.includes('store.json.bak'), files.join(','))
  const disk = JSON.parse(await readFile(file, 'utf8'))
  check('快照版本升到 2', disk.version === 2, String(disk.version))
  check('快照里有 paperKeys', disk.paperKeys && Object.keys(disk.paperKeys).length > 0)
  check('提及写了 dictVersion', Object.values(disk.mentions).every((m) => typeof m.dictVersion === 'string'))

  console.log('\n[9] 老快照（无 paperKeys）能就地重建')
  const legacyFile = join(dir, 'legacy.json')
  const legacy = new Store(legacyFile)
  await legacy.load()
  legacy.papers.set('p_0123456789abcdef', {
    id: 'p_0123456789abcdef',
    title: 'Legacy Paper',
    doi: '10.5555/legacy',
    year: 2019,
    fields: ['未分类'],
    depth: 'fulltext',
    chars: 400,
    hitCount: 1,
    readAt: 1,
    updatedAt: 1,
  })
  legacy.paperKeys.clear()
  await legacy.save()
  const reloaded = new Store(legacyFile)
  await reloaded.load()
  check('重建出 doi 键', reloaded.paperKeys.get('doi:10.5555/legacy') === 'p_0123456789abcdef')
  check('重建出 title 键', reloaded.paperKeys.get('title:' + normalizeTitleKey('Legacy Paper')) === 'p_0123456789abcdef')
  check('旧 id 保持不变', reloaded.papers.has('p_0123456789abcdef'))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
