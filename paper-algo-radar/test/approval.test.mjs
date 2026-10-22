/**
 * W1-04 验收：写能力开关（FR-8.6）+ 写审批闸门（FR-8.5）。
 *
 * 审批结算表是纯函数式的，用假 ctx / 假 exec 直接测，不需要宿主。
 * 运行：node test/approval.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { requestWriteApproval, describeApprovalVerdict } from '../lib/approval.js'
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../lib/contract.js'

const { __test, apply } = await import('../lib/index.js')

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

const dir = await mkdtemp(join(tmpdir(), 'radar-approval-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = dir

function fakeCtx({ approval, tools = new Map() } = {}) {
  return {
    _tools: tools,
    get: (name) => (name === 'approval' ? approval : undefined),
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get: (name) => tools.get(name),
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
  }
}

try {
  console.log('\n[1] 审批结算表')
  const exec = { agent: { session: {} }, name: 'radar_import', callId: 'c1', signal: undefined }

  for (const [outcome, expected] of [
    ['allowed-once', 'allowed'],
    ['rejected', 'declined'],
    ['cancelled', 'declined'],
    ['unavailable', 'unavailable'],
    ['某个没见过的值', 'unavailable'],
  ]) {
    const ctx = { get: () => ({ request: async () => outcome }) }
    const verdict = await requestWriteApproval(ctx, exec)
    check(`outcome=${outcome} → ${expected}`, verdict === expected, verdict)
  }

  console.log('\n[2] 失败关闭的几种情况')
  check('没有审批服务 → unavailable', (await requestWriteApproval({ get: () => undefined }, exec)) === 'unavailable')
  check('没有 ctx.get → unavailable', (await requestWriteApproval({}, exec)) === 'unavailable')
  check('审批服务没有 request → unavailable', (await requestWriteApproval({ get: () => ({}) }, exec)) === 'unavailable')
  check('没有 agent → unavailable', (await requestWriteApproval({ get: () => ({ request: async () => 'allowed-once' }) }, {})) === 'unavailable')

  const throwing = { get: () => ({ request: async () => { throw new Error('会话外不能问') } }) }
  check('request 抛错 → unavailable', (await requestWriteApproval(throwing, exec)) === 'unavailable')

  console.log('\n[3] 传给宿主的请求形状')
  let captured = null
  const capturing = { get: () => ({ request: async (req) => { captured = req; return 'allowed-once' } }) }
  await requestWriteApproval(capturing, exec, '自定义理由')
  check('带 agent', captured?.agent === exec.agent)
  check('带 toolName', captured?.toolName === 'radar_import', String(captured?.toolName))
  check('带 callId', captured?.callId === 'c1')
  check('带 reason', captured?.reason === '自定义理由', String(captured?.reason))
  check('带中英双语 displayReason', typeof captured?.displayReason?.en === 'string' && typeof captured?.displayReason?.zh === 'string')

  console.log('\n[4] 文案')
  check('declined 说清没改动', describeApprovalVerdict('declined').includes('没有'))
  check('unavailable 说清没改动', describeApprovalVerdict('unavailable').includes('没有'))
  check('allowed 是简短确认', describeApprovalVerdict('allowed').includes('批准'))

  console.log('\n[5] writeEnabled 开关（默认开）')
  {
    const ctx = fakeCtx()
    await apply(ctx)
    const names = [...ctx._tools.keys()]
    check('默认注册了写工具', WRITE_TOOL_NAMES.every((n) => names.includes(n)), names.join(','))
    check('读工具也都在', READ_TOOL_NAMES.every((n) => names.includes(n)))
    check('工具总数 = 读 + 写', names.length === READ_TOOL_NAMES.length + WRITE_TOOL_NAMES.length, String(names.length))
  }

  console.log('\n[6] writeEnabled=false')
  {
    const ctx = fakeCtx()
    await apply(ctx, { writeEnabled: false })
    const names = [...ctx._tools.keys()]
    check('不注册任何写工具', !WRITE_TOOL_NAMES.some((n) => names.includes(n)), names.join(','))
    check('读工具照常注册', READ_TOOL_NAMES.every((n) => names.includes(n)), names.join(','))
    check('只剩读工具', names.length === READ_TOOL_NAMES.length, `${names.length} vs ${READ_TOOL_NAMES.length}`)
    const status = await ctx._tools.get('radar_status').execute()
    check('状态里 capabilities.write=false', status.capabilities?.write === false, JSON.stringify(status.capabilities))
  }

  console.log('\n[7] 默认（不传 config）仍然是开')
  {
    const ctx = fakeCtx()
    await apply(ctx, undefined)
    check('不传 config 时写工具在', [...ctx._tools.keys()].includes('radar_add'))
    const status = await ctx._tools.get('radar_status').execute()
    check('capabilities.write=true', status.capabilities?.write === true)
  }
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
