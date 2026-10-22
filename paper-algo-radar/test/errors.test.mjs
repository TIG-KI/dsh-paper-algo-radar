/**
 * T-17 验收：typed error（§10.3）。
 *
 * 只测错误词汇与映射；路由层的 HTTP 形状在 e2e 里验。
 * 运行：node test/errors.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ERROR_CODES, ERROR_HTTP_STATUS, RadarError, toErrorPayload, toHttpError } from '../lib/errors.js'

const { __test } = await import('../lib/index.js')
const { Store, ingestPaper, removePaper } = __test

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

console.log('\n[1] 错误词汇表')
const codes = Object.values(ERROR_CODES)
check('12 个错误码', codes.length === 12, String(codes.length))
check('每个码都有 HTTP 映射', codes.every((code) => typeof ERROR_HTTP_STATUS[code] === 'number'))
check('VALIDATION → 400', ERROR_HTTP_STATUS.VALIDATION === 400)
check('NOT_FOUND → 404', ERROR_HTTP_STATUS.NOT_FOUND === 404)
check('PAYLOAD_TOO_LARGE → 413', ERROR_HTTP_STATUS.PAYLOAD_TOO_LARGE === 413)
check('UPSTREAM_FAILED → 502', ERROR_HTTP_STATUS.UPSTREAM_FAILED === 502)

console.log('\n[2] RadarError 形状')
const err = new RadarError('VALIDATION', '正文过短', { field: 'text' })
check('是 Error 实例', err instanceof Error)
check('带 code', err.code === 'VALIDATION')
check('带 field', err.field === 'text')
check('name 固定', err.name === 'RadarError')
const unknown = new RadarError('NOT_A_CODE', 'x')
check('未知 code 收敛为 INTERNAL', unknown.code === 'INTERNAL', unknown.code)

console.log('\n[3] toErrorPayload')
const p1 = toErrorPayload(err)
check('RadarError → {code,message,field}', p1.code === 'VALIDATION' && p1.message === '正文过短' && p1.field === 'text')
const p2 = toErrorPayload(new Error('普通异常'))
check('普通 Error → INTERNAL', p2.code === 'INTERNAL' && p2.message === '普通异常')
const p3 = toErrorPayload('字符串异常')
check('非 Error → INTERNAL', p3.code === 'INTERNAL' && p3.message === '字符串异常')
check('不带堆栈字段', !('stack' in p1))

console.log('\n[4] toHttpError')
const h1 = toHttpError(err)
check('VALIDATION → 400', h1.status === 400 && h1.payload.code === 'VALIDATION')
const h2 = toHttpError(new RadarError('NOT_FOUND', '没有这篇'))
check('NOT_FOUND → 404', h2.status === 404)

console.log('\n[5] 真实路径抛出 typed error')
const dir = await mkdtemp(join(tmpdir(), 'radar-err-'))
try {
  const store = new Store(join(dir, 'store.json'))
  await store.load()

  let shortError = null
  try {
    await ingestPaper(store, { title: 'x', text: '太短' })
  } catch (e) {
    shortError = e
  }
  check('正文过短 → RadarError', shortError instanceof RadarError, String(shortError))
  check('code=VALIDATION', shortError?.code === 'VALIDATION', shortError?.code)
  check('field=text', shortError?.field === 'text', shortError?.field)
  check('消息里不含正文', !String(shortError?.message ?? '').includes('太短'))

  let idError = null
  try {
    await removePaper(store, '')
  } catch (e) {
    idError = e
  }
  check('缺 id → RadarError VALIDATION', idError instanceof RadarError && idError.code === 'VALIDATION')
  check('field=paperId', idError?.field === 'paperId', idError?.field)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
