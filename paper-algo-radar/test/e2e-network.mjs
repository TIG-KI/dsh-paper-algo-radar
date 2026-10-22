/**
 * 需要**真实网络**的验收：快速添加（arXiv / DOI）与多源检索。
 * 与其它测试分开，因为断网时必然失败——失败说明网络，不说明代码。
 *
 * 运行：node test/e2e-network.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { Store, buildAddTool } = __test
const { discover } = await import('../lib/sources.js')

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

const dir = await mkdtemp(join(tmpdir(), 'radar-net-'))
const store = new Store(join(dir, 'store.json'))
await store.load()
const add = buildAddTool(async () => store)

try {
  console.log('\n[1] 多源检索（真网络）')
  const found = await discover('named entity recognition transformer', { limit: 4 })
  const okSources = found.sources.filter((s) => s.status === 'ok').length
  console.log('  源状态：' + found.sources.map((s) => `${s.name}=${s.status}(${s.count})`).join(' '))
  check('至少两个源可用', okSources >= 2, `${okSources} 个`)
  check('拿到结果', found.items.length > 0, String(found.items.length))
  check('结果来自多个源', new Set(found.items.map((i) => i.source)).size >= 2, [...new Set(found.items.map((i) => i.source))].join(','))

  console.log('\n[2] 快速添加：arXiv id')
  const added = await add.execute({ input: '2401.12345' })
  check('登记成功', added.total >= 0, JSON.stringify(added.paper?.title ?? ''))
  check('标题非空', String(added.paper?.title ?? '').length > 0, added.paper?.title)
  check('深度是全文或摘要', ['fulltext', 'abstract'].includes(added.paper?.depth), added.paper?.depth)
  check('记下了 arXiv id', added.paper?.arxivId === '2401.12345', added.paper?.arxivId)
  check('留存了正文', added.paper?.hasText === true, String(added.paper?.hasText))
  console.log(`  命中 ${added.total} 个算法，深度 ${added.paper?.depth}，字符 ${added.chars}`)

  console.log('\n[3] 重复登记同一篇 → 不新增')
  const again = await add.execute({ input: 'https://arxiv.org/abs/2401.12345' })
  check('仍是一篇', store.papers.size === 1, String(store.papers.size))
  check('created=false', again.created === false, String(again.created))

  console.log('\n[4] 快速添加：DOI（非 arXiv，只有摘要）')
  let doiResult = null
  let doiError = null
  try {
    doiResult = await add.execute({ input: '10.1007/s11356-016-7812-9' })
  } catch (error) {
    doiError = error
  }
  if (doiError !== null) {
    // 摘要太短被拒是合理结果（不是 bug）：Crossref 的摘要常常不足 120 字符
    check('DOI 路径给出明确错误而不是崩', ['EXTRACT_FAILED', 'VALIDATION'].includes(doiError.code), doiError.code)
    console.log(`  DOI 登记被拒：${doiError.code} — ${doiError.message.slice(0, 60)}`)
  } else {
    check('DOI 登记成功', doiResult.total >= 0)
    check('记下了 DOI', doiResult.paper?.doi === '10.1007/s11356-016-7812-9', doiResult.paper?.doi)
  }

  console.log('\n[5] 认不出的输入')
  let bad = null
  try {
    await add.execute({ input: '这不是一个 DOI' })
  } catch (error) {
    bad = error
  }
  check('抛 VALIDATION', bad?.code === 'VALIDATION', String(bad?.code))
  check('报错里给了线索', String(bad?.message ?? '').includes('DOI'), bad?.message)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '网络端到端通过' : '网络端到端有失败（先确认能上网）'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
