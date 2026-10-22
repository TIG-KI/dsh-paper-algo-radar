/**
 * W1.1 验收：PDF 登记（§7 FR-1.8 / FR-10.8）。
 *
 * 用**手工构造的合法 PDF** 测，不依赖外部文件：
 *  - 未压缩内容流
 *  - FlateDecode 压缩流
 *  - 纯图（扫描件）→ 必须明确报 UNSUPPORTED_MEDIA
 *
 * 跑真实子进程（不是 mock）验证 FR-10.8 的隔离；超时路径用注入的 runner 模拟。
 *
 * 运行：node test/pdf.test.mjs
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { extractPdfText, extractTextFromContent, hexPdfString, unescapePdfString } from '../lib/pdf.js'
import { extractPdfInWorker, setPdfRunner } from '../lib/pdfrun.js'

const { __test } = await import('../lib/index.js')
const { Store, buildAddTool } = __test

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
  '本文提出一种基于 LSTM 与 CRF 的命名实体识别方法。方法部分用双向 LSTM 编码上下文，用 CRF 建模标签转移，' +
  '优化器使用 Adam。实验部分与 SVM、随机森林对比，评价指标为 F1，并报告消融结果：去掉 CRF 后 F1 下降约 1.8 个百分点。' +
  '我们还在三个公开数据集上重复实验，训练使用早停策略，验证集与测试集严格分离，标注体系遵循 BMES 方案。' +
  '为检验稳健性，把训练语料按句长分层后重新评估，结论一致；对低资源条件也做了分析，指出仍需引入迁移学习。' +
  '结论总结了方法的适用边界，并公开预处理脚本与超参数配置，便于在同一数据划分上复现全部数字。' +
  '最后我们讨论了方法的局限：跨领域迁移时对分词质量敏感，长句的实体边界仍有混淆。'

if ([...BODY].length < 300) throw new Error('测试正文太短：' + [...BODY].length)

/** 生成一个最小可解析 PDF。`compressed` 决定内容流是否 Flate。 */
function makePdf({ text, compressed = false, withText = true }) {
  // 内容流：逐行 BT/Td/Tj/ET，模拟真实排版。
  // 非 ASCII 用十六进制 UTF-16BE 串（`<...> Tj`）——真实 PDF 就是这么存中文的；
  // 用 latin1 直接写中文会被截断成乱码，那不是合法的测试素材。
  const lines = withText ? String(text).match(/.{1,60}/g) ?? [] : []
  let content = ''
  if (withText) {
    lines.forEach((line, index) => {
      const isAscii = [...line].every((ch) => ch.codePointAt(0) < 0x80)
      let shown
      if (isAscii) {
        shown = `(${line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
      } else {
        const hex = [...line].map((ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
        shown = `<${hex}>`
      }
      content += `BT /F1 12 Tf 72 ${740 - index * 16} Td ${shown} Tj ET\n`
    })
  } else {
    // 纯图页：只有画图算子，没有文本
    content = 'q 612 0 0 792 0 0 cm /Im1 Do Q\n'
  }
  const contentBytes = Buffer.from(content, 'latin1')
  const streamBytes = compressed ? deflateSync(contentBytes) : contentBytes
  const filter = compressed ? ' /Filter /FlateDecode' : ''

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
  ]
  const head = Buffer.from(`%PDF-1.4\n${objects.join('')}4 0 obj\n<< /Length ${streamBytes.length}${filter} >>\nstream\n`, 'latin1')
  const tail = Buffer.from(`\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1')
  return Buffer.concat([head, streamBytes, tail])
}

const dir = await mkdtemp(join(tmpdir(), 'radar-pdf-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
const addTool = buildAddTool(async () => store)

try {
  console.log('\n[1] 底层解析')
  check('转义 \\\\( 恢复成 (', unescapePdfString('a\\(b') === 'a(b')
  check('八进制转义', unescapePdfString('\\101') === 'A')
  check('十六进制串（两字节一组）', hexPdfString('00480069') === 'Hi')
  check('内容流里取 Tj', extractTextFromContent('BT (Hello) Tj ET').includes('Hello'))
  check('内容流里取 TJ 数组', extractTextFromContent('BT [(Hel) -20 (lo)] TJ ET').includes('Hel'))

  const plain = makePdf({ text: BODY })
  const plainResult = extractPdfText(plain)
  check('未压缩流能抽出文字', plainResult.text.includes('LSTM'), plainResult.text.slice(0, 40))
  check('诊断里没有「空文本」告警', !plainResult.diagnostics.some((d) => d.includes('没有可提取')), JSON.stringify(plainResult.diagnostics))
  check('解出了流', plainResult.decoded >= 1, String(plainResult.decoded))

  const compressed = makePdf({ text: BODY, compressed: true })
  const compressedResult = extractPdfText(compressed)
  check('FlateDecode 流能解压并抽出文字', compressedResult.text.includes('CRF'), compressedResult.text.slice(0, 40))

  const scanned = makePdf({ withText: false })
  const scannedResult = extractPdfText(scanned)
  check('纯图 PDF 抽不到文字', scannedResult.text === '', scannedResult.text.slice(0, 40))
  check('给出「扫描件」诊断', scannedResult.diagnostics.some((d) => d.includes('扫描件')), JSON.stringify(scannedResult.diagnostics))

  console.log('\n[2] 子进程真实跑一遍（FR-10.8）')
  const pdfPath = join(dir, 'paper.pdf')
  await writeFile(pdfPath, compressed)
  const viaWorker = await extractPdfInWorker(pdfPath, { timeoutMs: 15000 })
  check('子进程返回了文本', String(viaWorker.text).includes('LSTM'), String(viaWorker.text).slice(0, 40))
  check('子进程带诊断字段', Array.isArray(viaWorker.diagnostics))

  console.log('\n[3] radar_add({ pdfPath }) 登记')
  const added = await addTool.execute({ pdfPath, fields: 'NLP' })
  check('登记成功', added.total >= 0)
  check('深度是 fulltext', added.paper?.depth === 'fulltext', added.paper?.depth)
  check('标题从正文首行猜出来', String(added.paper?.title ?? '').length > 8, added.paper?.title)
  check('留存了正文（可重算）', added.paper?.hasText === true)
  check('回报了 pdf.discarded', added.pdf?.discarded === true)
  // 标题允许从首行猜（≤120 字符），所以断言用正文靠后的句子：正文任何一段都不该被回显。
  check('没有回显正文', !JSON.stringify({ ...added, pdf: undefined }).includes('按句长分层后重新评估'))
  check('texts/ 里只有留存的正文，没有 PDF', (await readdir(join(dir, 'texts'))).every((f) => f.endsWith('.txt.gz')), (await readdir(join(dir, 'texts'))).join(','))

  console.log('\n[4] 扫描件必须明确失败')
  const scanPath = join(dir, 'scan.pdf')
  await writeFile(scanPath, scanned)
  let scanError = null
  try {
    await addTool.execute({ pdfPath: scanPath })
  } catch (error) {
    scanError = error
  }
  check('抛 UNSUPPORTED_MEDIA', scanError?.code === 'UNSUPPORTED_MEDIA', String(scanError?.code))
  check('提示里说清原因', String(scanError?.message ?? '').includes('扫描件'), scanError?.message?.slice(0, 60))
  check('没有因此多出一篇论文', store.papers.size === 1, String(store.papers.size))

  console.log('\n[5] 错误路径')
  let missing = null
  try {
    await addTool.execute({ pdfPath: join(dir, 'nope.pdf') })
  } catch (error) {
    missing = error
  }
  check('文件不存在 → NOT_FOUND', missing?.code === 'NOT_FOUND', String(missing?.code))

  let notPdf = null
  const notPdfPath = join(dir, 'not.pdf')
  await writeFile(notPdfPath, '这不是 PDF')
  try {
    await addTool.execute({ pdfPath: notPdfPath })
  } catch (error) {
    notPdf = error
  }
  check('不是 PDF → UNSUPPORTED_MEDIA 或 EXTRACT_FAILED', ['UNSUPPORTED_MEDIA', 'EXTRACT_FAILED'].includes(notPdf?.code), String(notPdf?.code))

  console.log('\n[6] 超时（注入 runner 模拟）')
  setPdfRunner(async () => {
    throw Object.assign(new Error('PDF 解析超时（20000ms）'), { code: 'PDF_TIMEOUT' })
  })
  let timeoutError = null
  try {
    await addTool.execute({ pdfPath })
  } catch (error) {
    timeoutError = error
  }
  setPdfRunner(null)
  check('超时 → EXTRACT_FAILED', timeoutError?.code === 'EXTRACT_FAILED', String(timeoutError?.code))
  check('错误里带「超时」', String(timeoutError?.message ?? '').includes('超时'), timeoutError?.message?.slice(0, 40))

  console.log('\n[7] 批量 PDF（FR-1.9）：单条失败不影响其余')
  {
    const goodA = join(dir, 'a.pdf')
    const goodB = join(dir, 'b.pdf')
    const bad = join(dir, 'scan2.pdf')
    await writeFile(goodA, makePdf({ text: BODY, compressed: true }))
    await writeFile(goodB, makePdf({ text: BODY + ' 另一篇的补充说明。' }))
    await writeFile(bad, makePdf({ withText: false }))

    const { buildAddBatchTool } = __test
    const batchTool = buildAddBatchTool(async () => store)
    const batch = await batchTool.execute({ pdfPaths: [goodA, bad, goodB], fields: '批量' })
    check('处理了 3 条', batch.results.length === 3, String(batch.results.length))
    check('成功 2 条', batch.completed === 2, String(batch.completed))
    check('失败 1 条', batch.failed === 1, String(batch.failed))
    check('失败那条是扫描件', batch.results[1].code === 'UNSUPPORTED_MEDIA', String(batch.results[1].code))
    check('失败项带路径', batch.results[1].path === bad)
    check('成功项带算法数', batch.results[0].algorithms >= 0)
    check('成功项带深度', batch.results[2].depth === 'fulltext')
  }

  console.log('\n[8] 20MB 上限')
  const bigPath = join(dir, 'big.pdf')
  await writeFile(bigPath, Buffer.alloc(21 * 1024 * 1024))
  let bigError = null
  try {
    await addTool.execute({ pdfPath: bigPath })
  } catch (error) {
    bigError = error
  }
  check('超大 → PAYLOAD_TOO_LARGE', bigError?.code === 'PAYLOAD_TOO_LARGE', String(bigError?.code))

  console.log('\n[9] 乱码闸门：字形码 / 二进制不能进库')
  // 长度足够（>300）但全是控制符：真实 PDF 里 CID 字体、被误当内容流的图片流就是这样。
  const garbageText = Array.from({ length: 400 }, (_, i) => String.fromCharCode(1 + ((i * 37) % 31))).join('')
  const garbagePdf = makePdf({ text: garbageText })
  const garbageQuality = extractPdfText(garbagePdf)
  check('字形码文本被判不可用', garbageQuality.quality?.usable === false, JSON.stringify(garbageQuality.quality))
  check('给出了跳过流的诊断', garbageQuality.diagnostics.some((d) => d.includes('跳过')), JSON.stringify(garbageQuality.diagnostics))

  const garbagePath = join(dir, 'garbage.pdf')
  await writeFile(garbagePath, garbagePdf)
  const beforeCount = store.papers.size
  let garbageError = null
  try {
    await addTool.execute({ pdfPath: garbagePath })
  } catch (error) {
    garbageError = error
  }
  check('登记被拒（UNSUPPORTED_MEDIA）', garbageError?.code === 'UNSUPPORTED_MEDIA', String(garbageError?.code))
  check('提示里给出替代方案', /粘贴|OCR/.test(String(garbageError?.message ?? '')), garbageError?.message?.slice(0, 60))
  check('没有多出论文', store.papers.size === beforeCount, `${store.papers.size} vs ${beforeCount}`)

  // 粘贴路径同样要拦：把二进制内容当正文传进来，不该静默入库
  let pasteError = null
  try {
    await addTool.execute({ title: '二进制内容', text: garbageText })
  } catch (error) {
    pasteError = error
  }
  check('粘贴二进制 → VALIDATION', pasteError?.code === 'VALIDATION', String(pasteError?.code))
} finally {
  setPdfRunner(null)
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
