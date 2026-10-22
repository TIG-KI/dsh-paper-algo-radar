/**
 * 走真实宿主路由验证导入闭环（E6 的可用部分）：导出 → 再导入 → 库不变。
 *
 * 用法：node test/e2e-import.mjs <baseUrl> <token>
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

const boot = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (boot.headers.getSetCookie ? boot.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ')

const call = async (path, init = {}) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const dir = await mkdtemp(join(tmpdir(), 'radar-e2e-import-'))
try {
  const before = await call('/paper-algo-radar/state')
  console.log(`基线：${before.body.paperCount} 篇 / ${before.body.mentionCount} 次提及`)

  console.log('\n[1] 导出（GET /export 直接给 JSON 体）')
  const exported = await call('/paper-algo-radar/export')
  check('导出成功', exported.status === 200 && Array.isArray(exported.body.papers), String(exported.status))
  check('带 schemaVersion', exported.body.schemaVersion === 2, String(exported.body.schemaVersion))
  check('论文数与库一致', exported.body.papers.length === before.body.paperCount, `${exported.body.papers.length} vs ${before.body.paperCount}`)

  const file = join(dir, 'roundtrip.json')
  await writeFile(file, JSON.stringify(exported.body), 'utf8')

  console.log('\n[2] 导入预览（dryRun 默认）')
  const preview = await call('/paper-algo-radar/import', {
    method: 'POST',
    body: JSON.stringify({ path: file }),
  })
  check('默认 dryRun=true', preview.body.dryRun === true)
  check('识别为 export-v2', preview.body.kind === 'export-v2', preview.body.kind)
  check('新增 0 篇（都是已有的）', preview.body.added === 0, String(preview.body.added))
  check('更新 = 论文数', preview.body.updated === before.body.paperCount, `${preview.body.updated}`)
  check('preview 未写库', (await call('/paper-algo-radar/state')).body.paperCount === before.body.paperCount)

  console.log('\n[3] 真正导入同一份文件 → 库不变（E6 的幂等面）')
  const applied = await call('/paper-algo-radar/import', {
    method: 'POST',
    body: JSON.stringify({ path: file, dryRun: false }),
  })
  check('applied=true', applied.body.applied === true)
  check('新增 0 篇', applied.body.added === 0, String(applied.body.added))
  const after = await call('/paper-algo-radar/state')
  check('论文数不变', after.body.paperCount === before.body.paperCount, `${after.body.paperCount}`)
  check('提及数不变', after.body.mentionCount === before.body.mentionCount, `${after.body.mentionCount}`)
  check('算法数不变', after.body.algorithmCount === before.body.algorithmCount, `${after.body.algorithmCount}`)

  console.log('\n[4] 错误路径的形状（§10.3）')
  const missing = await call('/paper-algo-radar/import', {
    method: 'POST',
    body: JSON.stringify({ path: join(dir, 'nope.json') }),
  })
  check('文件不存在 → 404', missing.status === 404, String(missing.status))
  check('错误体带 code', missing.body?.error?.code === 'NOT_FOUND', JSON.stringify(missing.body))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '端到端通过' : '端到端有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
