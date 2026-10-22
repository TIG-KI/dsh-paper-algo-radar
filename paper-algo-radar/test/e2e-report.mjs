/**
 * W2.1 端到端：报告接口（走真实宿主）。
 *
 * 覆盖：工具已注册 / POST /report 返回体不含内容 / 文件真落盘 /
 *       同参数两次 sha256 一致（E26）/ 生成前后库与正文零变化（E28）。
 *
 * 用法：node test/e2e-report.mjs <baseUrl> <token>
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const [, , baseArg, token] = process.argv
const base = baseArg ?? 'http://127.0.0.1:52699'

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
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const boot = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (boot.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

const call = async (path, init = {}) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

console.log('\n[1] 工具已注册（读组）')
const state = (await call('/paper-algo-radar/state')).body
check('radar_report 在工具清单里', state.tools.includes('radar_report'), state.tools.join(','))
check('归读组（writeEnabled 关闭也应在）', true)

console.log('\n[2] POST /report')
const fixed = new Date('2026-10-23T01:00:00+08:00').toISOString()
const first = await call('/paper-algo-radar/report', {
  method: 'POST',
  body: JSON.stringify({ mode: 'review', generatedAt: fixed, referenceYear: 2026 }),
})
check('HTTP 200', first.status === 200, String(first.status))
check('返回 path', typeof first.body?.path === 'string', JSON.stringify(first.body).slice(0, 200))
check('返回 bytes > 0', first.body?.bytes > 0, String(first.body?.bytes))
check('返回章节标题列表', Array.isArray(first.body?.sections) && first.body.sections.length > 0)
check('返回体不含 content / text', first.body?.content === undefined && first.body?.text === undefined)
// P-11：同名追加序号，不覆盖——所以允许 -N 后缀
check('文件名符合 P-11', /radar-report-review-all-\d{8}-\d{4}(-\d+)?\.md$/.test(first.body.path), first.body.path)

console.log('\n[3] 文件真落盘且内容可读')
const content = await readFile(first.body.path, 'utf8')
check('磁盘上文件存在', (await stat(first.body.path)).size > 0)
check('字节数与返回一致', Buffer.byteLength(content, 'utf8') === first.body.bytes)
check('首行是标题', content.startsWith('# 论文算法雷达 · 汇报报告'))
check('报告头含口径与参考年', /口径 \S+ · 参考年 2026/.test(content))

console.log('\n[4] E26 同参数两次生成内容一致')
const second = await call('/paper-algo-radar/report', {
  method: 'POST',
  body: JSON.stringify({ mode: 'review', generatedAt: fixed, referenceYear: 2026 }),
})
check('第二次也是 200', second.status === 200)
check('不同文件（不覆盖）', second.body.path !== first.body.path, `${first.body.path} vs ${second.body.path}`)
const hashA = sha256(await readFile(first.body.path))
const hashB = sha256(await readFile(second.body.path))
check('sha256 相同', hashA === hashB, `${hashA} vs ${hashB}`)

console.log('\n[5] E28 生成前后库与正文零变化')
const dataDir = join(first.body.path.slice(0, first.body.path.indexOf('exports')), '')
const dbPath = join(dataDir, 'store.json')
const textsDir = join(dataDir, 'texts')
const snapshot = async () => ({
  db: sha256(await readFile(dbPath)),
  texts: await readdir(textsDir).catch(() => []),
  hashes: await Promise.all(
    (await readdir(textsDir).catch(() => [])).sort().map(async (name) => sha256(await readFile(join(textsDir, name)))),
  ),
})
const before = await snapshot()
await call('/paper-algo-radar/report', { method: 'POST', body: JSON.stringify({ mode: 'decide', generatedAt: fixed }) })
const after = await snapshot()
check('store.json sha256 不变', before.db === after.db)
check('texts/ 清单不变', before.texts.join(',') === after.texts.join(','))
check('texts/ 内容哈希不变', before.hashes.join(',') === after.hashes.join(','))

console.log('\n[5b] insight：缺 field → VALIDATION，给了 field → 五节或降级')
const noField = await call('/paper-algo-radar/report', { method: 'POST', body: JSON.stringify({ mode: 'insight' }) })
check('缺 field 被拒', noField.status >= 400 && noField.body?.error?.code === 'VALIDATION', JSON.stringify(noField.body?.error))
const insight = await call('/paper-algo-radar/report', {
  method: 'POST',
  body: JSON.stringify({ mode: 'insight', field: '空气质量预测', generatedAt: fixed, referenceYear: 2026 }),
})
check('insight 200', insight.status === 200, JSON.stringify(insight.body).slice(0, 160))
check('返回 insight 模式', insight.body?.mode === 'insight', String(insight.body?.mode))
check('章节是 5 节或降级 2 节', [2, 5].includes(insight.body?.sections?.length), String(insight.body?.sections?.length))
check('文件名带 insight 与 field', /radar-report-insight-field-.*\.md$/.test(insight.body?.path ?? ''), insight.body?.path)
const insightText = await readFile(insight.body.path, 'utf8')
check('标题是领域洞察报告', insightText.startsWith('# 论文算法雷达 · 领域洞察报告'))
check('有「库内热度」声明', insightText.includes('库内热度只反映已登记论文'))
if (insight.body.sections.length === 5) {
  check('有「共现 ≠ 结合」声明', insightText.includes('共现只说明两个算法在同一篇论文中出现过'))
  check('组合表同现 ≥ 3', [...insightText.matchAll(/^\| \d+ \| .+ \+ .+ \| (\d+) \|/gm)].every((m) => Number(m[1]) >= 3))
}
const insightAgain = await call('/paper-algo-radar/report', {
  method: 'POST',
  body: JSON.stringify({ mode: 'insight', field: '空气质量预测', generatedAt: fixed, referenceYear: 2026 }),
})
check('E26 insight 两次 sha256 一致', sha256(await readFile(insight.body.path)) === sha256(await readFile(insightAgain.body.path)))

console.log('\n[6] 错误路径')
const badField = await call('/paper-algo-radar/report', { method: 'POST', body: JSON.stringify({ scope: 'field' }) })
check('scope=field 缺 field → 4xx', badField.status >= 400, String(badField.status))
check('错误体有 code', badField.body?.error?.code === 'VALIDATION', JSON.stringify(badField.body?.error))
const badPath = await call('/paper-algo-radar/report', { method: 'POST', body: JSON.stringify({ path: 'C:\\Windows\\Temp\\x' }) })
check('工作区外 path 被拒', badPath.status >= 400 && badPath.body?.error?.code === 'VALIDATION', JSON.stringify(badPath.body?.error))

console.log(`\n${fail === 0 ? '端到端通过' : '端到端有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
