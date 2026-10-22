/**
 * 中文/CID PDF 支持（lib/pdf-fonts.js + lib/pdf.js 的字体感知路径）。
 *
 * 背景：CNKI 这类中文 PDF 用 Type0 + Identity-H，内容流里是**字形号**。
 * 旧版直接按 latin1 读，抽出来是乱码，长度还过千，于是以乱码入库。
 * 现在顺着 `/ToUnicode` 的 CMap 把字形号映射回 Unicode；没有 ToUnicode 时
 * 再看预定义 CMap（UniGB-UCS2-H / GBK-EUC-H）。
 *
 * 全部用**手工构造的 PDF**，不依赖外部文件。
 *
 * 运行：node test/pdf-cid.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { extractPdfText } from '../lib/pdf.js'
import { parseToUnicode, decodeWithCMap, extractTextWithFonts } from '../lib/pdf-fonts.js'
import { analyzeText } from '../lib/textquality.js'

const { __test } = await import('../lib/index.js')
const { Store, buildAddTool, ingestPaper } = __test

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

const hex4 = (code) => code.toString(16).toUpperCase().padStart(4, '0')
const utf16Hex = (text) => [...text].map((ch) => hex4(ch.codePointAt(0))).join('')

/** 用固定对象编号拼一份最小 PDF；stream 用 Buffer 保证二进制安全。 */
function assemble(objects) {
  const buffers = [Buffer.from('%PDF-1.4\n', 'latin1')]
  objects.forEach((object, index) => {
    const num = object.num ?? index + 1
    const stream = object.stream
    const dict = stream === undefined ? object.dict : object.dict.replace('/Length 0', `/Length ${stream.length}`)
    buffers.push(Buffer.from(`${num} 0 obj\n${dict}\n`, 'latin1'))
    if (stream !== undefined) {
      buffers.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'))
    }
    buffers.push(Buffer.from('endobj\n', 'latin1'))
  })
  buffers.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'))
  return Buffer.concat(buffers)
}

/** 内容流：每行一个 BT/Td/Tj，行间纵坐标变化 → 抽出时应当断行。 */
function contentFor(lines, encodeLine) {
  return lines
    .map((line, index) => `BT /F1 12 Tf 72 ${740 - index * 20} Td ${encodeLine(line)} Tj ET`)
    .join('\n')
}

/** 构造「Type0 + Identity-H + ToUnicode」PDF：每个字符分配一个字形号。 */
function makeCidPdf({ lines, compressed = true }) {
  const codes = new Map()
  for (const line of lines) for (const ch of line) if (!codes.has(ch)) codes.set(ch, codes.size + 1)
  const bfchar = [...codes.entries()]
    .map(([ch, code]) => `<${hex4(code)}> <${utf16Hex(ch)}>`)
    .join('\n')
  const cmapText =
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
    `${codes.size} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nend\nend`
  const bodyText = contentFor(lines, (line) =>
    '<' + [...line].map((ch) => hex4(codes.get(ch))).join('') + '>',
  )
  const contentBytes = Buffer.from(bodyText, 'latin1')
  const contentStream = compressed ? deflateSync(contentBytes) : contentBytes
  return assemble([
    { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 7 0 R >>' },
    { dict: '<< /Font << /F1 5 0 R >> >>' },
    {
      dict:
        '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H ' +
        '/DescendantFonts [8 0 R] /ToUnicode 6 0 R >>',
    },
    {
      dict: `<< /Length 0${compressed ? ' /Filter /FlateDecode' : ''} >>`,
      stream: compressed ? deflateSync(Buffer.from(cmapText, 'latin1')) : Buffer.from(cmapText, 'latin1'),
    },
    {
      dict: `<< /Length 0${compressed ? ' /Filter /FlateDecode' : ''} >>`,
      stream: contentStream,
    },
    { dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>' },
  ])
}

/** 预定义 CMap（没有 ToUnicode）：内容流按该编码直接给字节。 */
function makePredefinedPdf({ encoding, lines, encodeLine }) {
  const bodyText = contentFor(lines, encodeLine)
  return assemble([
    { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 6 0 R >>' },
    { dict: '<< /Font << /F1 5 0 R >> >>' },
    {
      dict:
        `<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /${encoding} ` +
        '/DescendantFonts [7 0 R] >>',
    },
    { dict: '<< /Length 0 /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(bodyText, 'latin1')) },
    { dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>' },
  ])
}

const ZH_LINES = ['引入误差修正和参数优化的空气质量预测模型', '本文比较遗传算法与 LSTM 的预测效果，并用模拟退火调参。']

console.log('\n[1] CMap 解析')
{
  const cmap = parseToUnicode(
    'begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '2 beginbfchar\n<0001> <7535>\n<0002> <5B50>\nendbfchar',
  )
  check('codespacerange 识别为 2 字节', cmap.codeBytes === 2, String(cmap.codeBytes))
  check('bfchar 单字符映射', decodeWithCMap(Buffer.from([0, 1, 0, 2]), cmap) === '电子')

  const range = parseToUnicode(
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '1 beginbfrange\n<0001> <0003> <0041>\nendbfrange',
  )
  check('bfrange 递增映射', decodeWithCMap(Buffer.from([0, 1, 0, 2, 0, 3]), range) === 'ABC')

  const arrayRange = parseToUnicode(
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '1 beginbfrange\n<0001> <0002> [<4E2D> <6587>]\nendbfrange',
  )
  check('bfrange 数组目标', decodeWithCMap(Buffer.from([0, 1, 0, 2]), arrayRange) === '中文')
}

console.log('\n[2] Identity-H + ToUnicode（中文期刊 PDF 的典型结构）')
const cidPdf = makeCidPdf({ lines: ZH_LINES })
{
  const result = extractPdfText(cidPdf)
  const quality = analyzeText(result.text)
  check('抽出了中文正文', result.text.includes('空气质量预测模型'), JSON.stringify(result.text.slice(0, 60)))
  check('中文没有乱码', !/[\uE000-\uF8FF]/.test(result.text))
  check('质量判定可用', quality.usable, JSON.stringify(quality.reasons))
  check('两行之间断行', result.text.includes('\n'), JSON.stringify(result.text.slice(0, 80)))
  check('识别出 CID 字体', result.quality.cidFont === true)
  check('诊断里说明按 ToUnicode 解码', result.diagnostics.some((item) => item.includes('ToUnicode')), JSON.stringify(result.diagnostics))
}

console.log('\n[3] 预定义 CMap')
{
  const ucs2 = makePredefinedPdf({
    encoding: 'UniGB-UCS2-H',
    lines: ['中文测试'],
    encodeLine: (line) => `<${utf16Hex(line)}>`,
  })
  const ucs2Result = extractPdfText(ucs2)
  check('UniGB-UCS2-H 解出中文', ucs2Result.text.includes('中文测试'), JSON.stringify(ucs2Result.text))

  // GBK 字节：中文 = D6 D0 CE C4
  const gbk = makePredefinedPdf({
    encoding: 'GBK-EUC-H',
    lines: ['中文'],
    encodeLine: () => '(\\326\\320\\316\\304)',
  })
  const gbkResult = extractPdfText(gbk)
  check('GBK-EUC-H 解出中文', gbkResult.text.includes('中文'), JSON.stringify(gbkResult.text))
}

console.log('\n[4] 没有 ToUnicode 的 Identity-H 仍要拒收')
{
  const broken = assemble([
    { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 6 0 R >>' },
    { dict: '<< /Font << /F1 5 0 R >> >>' },
    { dict: '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [7 0 R] >>' },
    {
      dict: '<< /Length 0 /Filter /FlateDecode >>',
      stream: deflateSync(
        Buffer.from('BT /F1 12 Tf 72 740 Td <00010002000300040005000600070008> Tj ET', 'latin1'),
      ),
    },
    { dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>' },
  ])
  const result = extractPdfText(broken)
  check('字形码没有当成正文', analyzeText(result.text).usable === false, JSON.stringify(result.text.slice(0, 40)))
}

console.log('\n[5] 对象流（/ObjStm）里的页面与字体也能解')
{
  // 页面 / 资源 / 字体都打包进对象流（对象号 3 / 4 / 5），PDF 里只有 ObjStm 对象本身
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources 4 0 R /Contents 6 0 R >>'
  const resources = '<< /Font << /F1 5 0 R >> >>'
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /T /Encoding /UniGB-UCS2-H /DescendantFonts [8 0 R] >>'
  const bodies = [page, resources, font]
  const numbers = [3, 4, 5]
  const offsets = []
  let cursor = 0
  for (const body of bodies) {
    offsets.push(cursor)
    cursor += body.length + 1
  }
  const header = numbers.map((num, index) => `${num} ${offsets[index]}`).join(' ')
  const objStmBody = `${header} ${bodies.join(' ')}`
  const first = header.length + 1
  const content = `BT /F1 12 Tf 72 740 Td <${utf16Hex('对象流测试')}> Tj ET`
  const pdf = assemble([
    { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 6, dict: '<< /Length 0 /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(content, 'latin1')) },
    {
      num: 9,
      dict: `<< /Length 0 /Filter /FlateDecode /Type /ObjStm /N 3 /First ${first} >>`,
      stream: deflateSync(Buffer.from(objStmBody, 'latin1')),
    },
  ])
  const withFonts = extractTextWithFonts(pdf)
  check('对象流补出了页面对象', withFonts.pageCount >= 1, `pages=${withFonts.pageCount} objects=${withFonts.objectCount}`)
  const result = extractPdfText(pdf)
  check('对象流里的字体也生效', result.text.includes('对象流测试'), JSON.stringify(result.text.slice(0, 60)))
}

console.log('\n[6] 端到端：radar_add({ pdfPath }) 收录中文论文')
const dir = await mkdtemp(join(tmpdir(), 'radar-cid-'))
try {
  const store = new Store(join(dir, 'store.json'))
  await store.load()
  const addTool = buildAddTool(async () => store)
  const body =
    '本文提出一种混合预测框架，先用遗传算法筛选特征，再用粒子群优化超参数，最后用 LSTM 建模残差。' +
    '实验部分在三个城市的空气质量指数数据上比较了模拟退火与蝙蝠算法的调参效果，评价指标为均方根误差、' +
    '平均绝对误差与决定系数。消融实验表明，去掉遗传算法筛选后误差明显上升，去掉粒子群优化后收敛更慢；' +
    '把模拟退火换成网格搜索，训练时间多出三倍而精度没有提升。稳健性检验覆盖了不同季节与不同监测站点，' +
    '结论保持一致。最后总结了方法的适用边界，并公开预处理脚本与超参数配置，便于在同一数据划分上复现全部数字。' +
    '数据来源包括全国城市空气质量实时发布平台与地方监测站的逐小时记录，缺失值用线性插值补齐，异常值按三倍' +
    '标准差剔除。特征工程部分构造了滞后项、滑动窗口统计量与气象协变量，并用互信息做了初步筛选；' +
    '模型训练采用五折交叉验证，早停耐心设为十个轮次，学习率按余弦退火衰减。为便于复现，所有随机种子固定，' +
    '实验重复五次取均值与标准差。进一步的分析显示，遗传算法筛出的特征子集在不同城市之间高度重叠，' +
    '说明该步骤具有一定迁移性；而粒子群优化的收益主要集中在超参数敏感的长短期记忆网络模型上。' +
    '我们还讨论了计算成本：在同等硬件下，完整流程比单一模型多出约两成时间，但仍显著快于穷举搜索。'
  const pdf = makeCidPdf({ lines: ['引入误差修正和参数优化的空气质量预测模型', body] })
  const pdfPath = join(dir, 'paper.pdf')
  await writeFile(pdfPath, pdf)

  const added = await addTool.execute({ pdfPath, title: '中文 CID 测试论文' })
  const paper = added.paper
  check('登记成功', paper?.depth === 'fulltext', JSON.stringify(paper?.depth))
  check('标题正确（中文）', paper?.title === '中文 CID 测试论文' || /误差修正/.test(paper?.title ?? ''), paper?.title)
  check('留存了正文', paper?.hasText === true)

  const mentions = [...store.mentions.values()].filter((mention) => mention.paperId === paper.id)
  const ids = mentions.map((mention) => mention.algorithmId)
  check('命中遗传算法', ids.includes('genetic-algorithm'), JSON.stringify(ids))
  check('命中粒子群优化', ids.includes('particle-swarm'))
  check('命中模拟退火', ids.includes('simulated-annealing'))
  check('命中 LSTM', ids.includes('lstm'))
  check('片段是中文而不是乱码', mentions.every((mention) => mention.snippets.every((snippet) => analyzeText(snippet).usable)))

  const stored = await readFile(join(dir, 'texts', `${paper.id}.txt.gz`))
  const { gunzipSync } = await import('node:zlib')
  const text = gunzipSync(stored).toString('utf8')
  check('留存正文是中文', text.includes('遗传算法') && text.includes('空气质量'), JSON.stringify(text.slice(0, 40)))
  check('留存正文质量可用', analyzeText(text).usable)

  // 同一份库再登记一遍，验证没有因为中文 id/键值出错
  const again = await ingestPaper(store, {
    title: '中文 CID 测试论文',
    text: body,
    depth: 'fulltext',
  })
  check('重复登记不新增论文', store.papers.size === 1 && again.created === false, String(store.papers.size))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
