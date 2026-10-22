/**
 * T-04 验收：抽取引擎 §8 R1–R8。
 *
 * 纯函数测试，不依赖宿主、不依赖存储。
 * 运行：node test/extract.test.mjs
 */
import {
  normalizeText,
  extract,
  buildMatchers,
  headingKeyOf,
  entryCaseSensitive,
  pluralOf,
  sliceCodePoints,
  codePointLength,
} from '../lib/extract.js'

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

const DICT = buildMatchers([
  { id: 'transformer', name: 'Transformer', type: 'DL', aliases: ['transformer', '变换器'] },
  { id: 'attention', name: 'Attention', type: 'DL', aliases: ['attention', '注意力'] },
  { id: 'self-attention', name: '自注意力', type: 'DL', aliases: ['self-attention', '自注意力'] },
  { id: 'cnn', name: 'CNN', type: 'DL', aliases: ['CNN'] },
  { id: 'svm', name: 'SVM', type: 'ML', aliases: ['SVM', 'support vector machine'] },
  { id: 'lstm', name: 'LSTM', type: 'DL', aliases: ['LSTM'] },
])

const pad = (s, n = 400) => s + '。'.repeat(Math.max(0, n - s.length))

console.log('\n[R1] 文本规范化')
{
  const t = normalizeText('ＡＢＣ　ｄｅｆ') // 全角
  check('NFKC 把全角折成半角', t === 'ABC def', JSON.stringify(t))
  check('删除零宽字符', normalizeText('a\u200bb\ufeffc') === 'abc')
  check('删除双向控制符', normalizeText('a\u202eb') === 'ab')
  check('\\r\\n 统一成 \\n', normalizeText('a\r\nb\rc') === 'a\nb\nc')
  check('≥3 换行折叠为 2', normalizeText('a\n\n\n\nb') === 'a\n\nb')
  check('保留 2 个换行', normalizeText('a\n\nb') === 'a\n\nb')
}

console.log('\n[R2] 页码与页眉行剔除')
{
  const body = [
    '引言',
    '本文研究时序预测。',
    '- 12 -',
    '3',
    'ICLR 2024 Submitted',
    '方法部分使用 LSTM。',
    'ICLR 2024 Submitted',
    '实验部分对比 SVM。',
    'ICLR 2024 Submitted',
    '结论。',
  ].join('\n')
  const r = extract(pad(body), DICT, { depth: 'fulltext' })
  check('页码行被删（- 12 - 与 3 都不在）', !/^- 12 -$/m.test(r.statsText) && !/^3$/m.test(r.statsText))
  check('重复页眉被删', !/ICLR 2024 Submitted/.test(r.statsText), r.statsText.slice(0, 80))
  check('正文行保留', r.statsText.includes('本文研究时序预测'))
  check('记录删除行数', r.removedLines >= 5, String(r.removedLines))
}

console.log('\n[R2] 章节关键词行即使重复也保留')
{
  const body = ['Abstract', 'abc', 'Abstract', 'def', 'Abstract', 'ghi'].join('\n')
  const r = extract(pad(body), DICT, { depth: 'fulltext' })
  const count = (r.statsText.match(/Abstract/g) ?? []).length
  check('Abstract 三行都保留', count === 3, String(count))
}

console.log('\n[R3] 参考文献截断')
{
  // 正常位置：L1 要求起始偏移 ≥ max(25%, 3000 code point)，所以正文必须够长
  const head = '正文。'.repeat(4000) // 12000 code points
  const body = head + '\n\nReferences\n[1] GAN. 2014.\n[2] SVM. 1995.\n'
  const r = extract(body, DICT, { depth: 'fulltext' })
  check('L1 命中', r.refCut.method === 'L1', JSON.stringify(r.refCut))
  check('截断后不含 References', !r.statsText.includes('References'))
  check('截断点在 25% 之后', r.refCut.at >= r.chars * 0.25 - 600, `${r.refCut.at} / ${r.chars}`)
  check('截断后的长度小于原文', r.chars < codePointLength(body))

  // 提前位置：25% 之前 → 不截断，只记 hint
  const early = 'References\n[1] GAN. 2014.\n' + '正文。'.repeat(400)
  const r2 = extract(early, DICT, { depth: 'fulltext' })
  check('提前出现不截断（method=null）', r2.refCut.method === null, JSON.stringify(r2.refCut))
  check('refHintEarly=true', r2.refHintEarly === true)

  // L2：无标题，但 30% 之后有 8 行以上编号条目
  const items = Array.from({ length: 9 }, (_, i) => `[${i + 1}] Some author. Some title. 2019.`).join('\n')
  const l2 = '正文。'.repeat(400) + '\n' + items + '\n'
  const r3 = extract(l2, DICT, { depth: 'fulltext' })
  check('L2 命中', r3.refCut.method === 'L2', JSON.stringify(r3.refCut))
  check('L2 截断后不含编号条目', !/^\[1\] Some author/m.test(r3.statsText))
}

console.log('\n[R4] 40 万 code point 上限，不切断代理对')
{
  const big = 'a'.repeat(400000) + '😀😀😀'
  const r = extract(big, DICT, { depth: 'fulltext' })
  check('chars 截到 400000', r.chars === 400000, String(r.chars))
  check('统计文本长度 400000', codePointLength(r.statsText) === 400000)
  check('没有被截断成半个代理对', !/[\uD800-\uDBFF]$/.test(r.statsText))
  check('sliceCodePoints 不切代理对', sliceCodePoints('😀😀😀', 2) === '😀😀')
}

console.log('\n[R5] 章节切分')
{
  check('英文标题命中 method', headingKeyOf('3 Method') === 'method')
  check('中文标题命中 experiment', headingKeyOf('实验设置') === 'experiment')
  check('中文标题命中 conclusion', headingKeyOf('结论') === 'conclusion')
  check('markdown 前缀也算', headingKeyOf('## Related Work') === 'related')
  check('句末标点的不算', headingKeyOf('我们用了 method。') === null)
  check('超过 80 code point 不算', headingKeyOf('Method ' + 'x'.repeat(100)) === null)
  check('无关键词的中文行不算', headingKeyOf('我们提出了一种新的编码结构') === null)
  check('关键词 + 补充说明算（前缀匹配）', headingKeyOf('Results and Discussion of the Model') === 'experiment')
  check('关键词 + 冒号补充算', headingKeyOf('Method: An Overview') === 'method')

  const body = ['Abstract', '摘　要 we use LSTM.', 'Introduction', '引言 attention.', 'Method', '方法里 CNN 与 SVM.'].join('\n')
  const r = extract(pad(body), DICT, { depth: 'fulltext' })
  const lstm = r.hits.find((h) => h.id === 'lstm')
  const attn = r.hits.find((h) => h.id === 'attention')
  const cnn = r.hits.find((h) => h.id === 'cnn')
  check('LSTM 归到 abstract', lstm?.sections.abstract === 1, JSON.stringify(lstm?.sections))
  check('attention 归到 intro', attn?.sections.intro === 1, JSON.stringify(attn?.sections))
  check('CNN 归到 method', cnn?.sections.method === 1, JSON.stringify(cnn?.sections))
  check('章节键是 experiment 不是 experiments', 'experiment' in (cnn?.sections ?? {}))
}

console.log('\n[R6] 别名匹配')
{
  check('条目级大小写敏感：CNN 条目', entryCaseSensitive(['CNN']) === true)
  check('普通词条目不敏感', entryCaseSensitive(['transformer']) === false)
  check('混合条目因含 CNN 而整体敏感', entryCaseSensitive(['CNN', 'convolutional neural network']) === true)

  // 中文别名不加边界：紧贴 ASCII 也要命中
  const r = extract(pad('本文使用LSTM注意力机制建模。'), DICT, { depth: 'fulltext' })
  check('中文别名紧贴 ASCII 仍命中', r.hits.some((h) => h.id === 'attention'), JSON.stringify(r.hits.map((h) => h.id)))

  // 同起点取最长：自注意力 消费掉 注意力 的起点
  const rLongest = extract(pad('本文使用自注意力机制建模。'), DICT, { depth: 'fulltext' })
  const ids = rLongest.hits.map((h) => h.id)
  check('自注意力命中', ids.includes('self-attention'), JSON.stringify(ids))
  check('被消费的「注意力」不重复计', !ids.includes('attention'), JSON.stringify(ids))

  // ASCII 边界：下划线也算边界字符
  const r2 = extract(pad('the transformer_x and transformer.'), DICT, { depth: 'fulltext' })
  const tf = r2.hits.find((h) => h.id === 'transformer')
  check('transformer_x 不算命中', tf?.count === 1, String(tf?.count))

  // 单复数
  check('复数：transformer → transformers', pluralOf('transformer') === 'transformers')
  check('复数：machine → machines', pluralOf('support vector machine') === 'support vector machines')
  check('复数：y → ies', pluralOf('colony') === 'colonies')
  check('复数：s 结尾 +es', pluralOf('class') === 'classes')
  check('大小写敏感条目不加复数', pluralOf('CNN') === 'CNNs')
  const r3 = extract(pad('we compare several transformers here.'), DICT, { depth: 'fulltext' })
  check('复数形能命中 transformer', r3.hits.some((h) => h.id === 'transformer'))

  // 大小写敏感：小写 cnn 不该命中
  const r4 = extract(pad('the cnn model and the CNN model.'), DICT, { depth: 'fulltext' })
  const cnn = r4.hits.find((h) => h.id === 'cnn')
  check('小写 cnn 不命中，大写 CNN 命中', cnn?.count === 1, String(cnn?.count))
}

console.log('\n[R7] 证据片段')
{
  const before = '甲'.repeat(200)
  const after = '乙'.repeat(300)
  const r = extract(pad(before + ' LSTM ' + after + ' 尾巴'), DICT, { depth: 'fulltext' })
  const lstm = r.hits.find((h) => h.id === 'lstm')
  check('片段 ≤ 3 条', lstm.snippets.length <= 3, String(lstm.snippets.length))
  check('每条 ≤ 200 code point', lstm.snippets.every((s) => codePointLength(s) <= 200), lstm.snippets.map(codePointLength).join(','))
  check('片段里含命中词', lstm.snippets.some((s) => s.includes('LSTM')), lstm.snippets[0])
  check('片段不含换行', lstm.snippets.every((s) => !s.includes('\n')))
}

console.log('\n[R8] 告警与统计')
{
  const short = 'LSTM 用了一下。'
  const r = extract(short, DICT, { depth: 'fulltext' })
  check('全文但 <3000 字符 → suspect:short', r.warnings.includes('suspect:short'), JSON.stringify(r.warnings))

  const long = ('LSTM 与 CNN 以及 SVM 的对比。'.repeat(400))
  const r2 = extract(long, DICT, { depth: 'fulltext' })
  check('长文无 short 告警', !r2.warnings.includes('suspect:short'), JSON.stringify(r2.warnings))

  const r3 = extract('很短的摘要', DICT, { depth: 'abstract', source: 'pdf' })
  check('PDF 短文本 → suspect:extract', r3.warnings.includes('suspect:extract'), JSON.stringify(r3.warnings))
}

console.log('\n[G] 确定性与纯函数')
{
  const body = pad('Abstract\n摘　要 LSTM 与 Transformer。\nMethod\n方法用 CNN 与 SVM，并以 Adam 优化。\nReferences\n[1] GAN. 2014.')
  const a = JSON.stringify(extract(body, DICT, { depth: 'fulltext', dictVersion: 'x' }))
  const b = JSON.stringify(extract(body, DICT, { depth: 'fulltext', dictVersion: 'x' }))
  check('同一输入两次结果逐字节一致', a === b)
  check('输出不含时间戳/随机值', !/\d{13}/.test(a))
  check('retainedText 是 R1 之后、R3 之前', extract(body, DICT, {}).retainedText.includes('References'))
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
