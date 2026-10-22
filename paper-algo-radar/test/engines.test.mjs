/**
 * FR-10.2 验收：引擎兼容性。
 *
 * 分两层，各有事实来源：
 *  - engines.dsh：宿主加载器在 import 插件之前校验（不满足的 bundle 被跳过，
 *    列入 skippedBundles）。插件侧不重复探测宿主版本——能跑到 apply() 就说明已通过。
 *  - engines.node：宿主不管，插件在 apply() 第一行校验；失败抛 ENGINE_MISMATCH，
 *    零注册、零读写。
 *
 * 运行：node test/engines.test.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, __test } = await import('../lib/index.js')
const {
  REQUIRED_DSH_RANGE,
  REQUIRED_NODE_RANGE,
  DSH_ENFORCED_BY,
  parseVersion,
  compareVersions,
  checkNodeEngine,
  assertNodeEngine,
  engineStateOf,
} = await import('../lib/engines.js')

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

function fakeCtx() {
  const tools = new Map()
  const stats = { registrations: 0, sections: 0, injectCalls: 0 }
  return {
    tools: {
      register(tool) {
        stats.registrations += 1
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get: (name) => tools.get(name),
    },
    systemPrompt: {
      getSectionOrder: () => 3000,
      section() {
        stats.sections += 1
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject() {
      stats.injectCalls += 1
      return () => {}
    },
    logger: { warn() {}, info() {}, error() {} },
    _tools: tools,
    _stats: stats,
  }
}

console.log('\n[1] 声明常量必须与 package.json 一致')
{
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  check('engines.dsh 已声明', typeof manifest.engines?.dsh === 'string', String(manifest.engines?.dsh))
  check('engines.dsh 与代码常量一致', manifest.engines?.dsh === REQUIRED_DSH_RANGE, `${manifest.engines?.dsh} vs ${REQUIRED_DSH_RANGE}`)
  check('engines.node 与代码常量一致', manifest.engines?.node === REQUIRED_NODE_RANGE, `${manifest.engines?.node} vs ${REQUIRED_NODE_RANGE}`)
  check('dsh 校验方标记为 host-loader', DSH_ENFORCED_BY === 'host-loader')
}

console.log('\n[2] 版本解析与比较（不能按字符串比）')
{
  check('22.19.0 可解析', parseVersion('22.19.0')?.nums.join('.') === '22.19.0')
  check('带 v 前缀可解析', parseVersion('v22.19.0')?.nums.join('.') === '22.19.0')
  check('预发布可解析', parseVersion('22.19.0-rc.1')?.pre.join('.') === 'rc.1')
  check('非法版本返回 null', parseVersion('not-a-version') === null)
  check('相等', compareVersions('22.19.0', '22.19.0') === 0)
  check('0.10.0 > 0.9.0（字符串比较会错）', compareVersions('0.10.0', '0.9.0') === 1)
  check('22.19.0 > 22.18.9', compareVersions('22.19.0', '22.18.9') === 1)
  check('22.19.0-rc.1 < 22.19.0', compareVersions('22.19.0-rc.1', '22.19.0') === -1)
  check('预发布数字段按数值比', compareVersions('1.0.0-rc.10', '1.0.0-rc.9') === 1)
  check('任一侧非法 → null', compareVersions('22.19.0', 'x') === null)
}

console.log('\n[3] Node 引擎判定（边界与失败关闭）')
{
  const current = checkNodeEngine(process.versions.node)
  check('当前 Node 满足要求', current.ok === true, JSON.stringify(current))
  check('边界 22.19.0 算满足', checkNodeEngine('22.19.0').ok === true)
  check('22.18.9 不满足', checkNodeEngine('22.18.9').ok === false)
  check('23.0.0 满足', checkNodeEngine('23.0.0').ok === true)
  check('22.19.0-rc.1 不满足（低于正式版）', checkNodeEngine('22.19.0-rc.1').ok === false)
  const bad = checkNodeEngine('garbage')
  check('无法解析时失败关闭', bad.ok === false)
  check('失败信息含要求版本', bad.message.includes('22.19.0'), bad.message)
  check('失败信息含当前版本', bad.message.includes('garbage'), bad.message)
  check('消息明确「不会激活」', bad.message.includes('不会激活'), bad.message)
}

console.log('\n[4] assertNodeEngine：不满足抛 ENGINE_MISMATCH')
{
  const fine = assertNodeEngine(process.versions.node)
  check('当前版本不抛', fine.ok === true)
  let error = null
  try {
    assertNodeEngine('21.0.0')
  } catch (caught) {
    error = caught
  }
  check('低版本抛错', error !== null && error.name === 'RadarError')
  check('错误码 ENGINE_MISMATCH', error?.code === 'ENGINE_MISMATCH', error?.code)
  check('带 engines.node 字段', error?.field === 'engines.node', error?.field)
  check('details 带 required/runtime', error?.details?.required === '22.19.0' && error?.details?.runtime === '21.0.0', JSON.stringify(error?.details))
}

console.log('\n[5] apply() 第一行拒绝：零注册、零读写')
{
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
  Object.defineProperty(process.versions, 'node', { value: '21.0.0', configurable: true, enumerable: true })
  try {
    const ctx = fakeCtx()
    let error = null
    try {
      await apply(ctx, {})
    } catch (caught) {
      error = caught
    }
    check('apply 拒绝激活', error?.code === 'ENGINE_MISMATCH', error?.message)
    check('没有注册任何工具', ctx._stats.registrations === 0, String(ctx._stats.registrations))
    check('没有注册提示段', ctx._stats.sections === 0, String(ctx._stats.sections))
    check('没有注册路由 / 请求服务', ctx._stats.injectCalls === 0, String(ctx._stats.injectCalls))
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor)
  }
  check('版本已恢复', process.versions.node === descriptor.value, process.versions.node)
}

console.log('\n[6] /state.engines 暴露诊断')
{
  const dir = await mkdtemp(join(tmpdir(), 'radar-engines-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const ctx = fakeCtx()
    await apply(ctx, {})
    check('正常 Node 激活成功', ctx._stats.registrations > 0, String(ctx._stats.registrations))
    const store = new __test.Store(join(dir, 'state.json'))
    await store.load()
    const state = __test.buildState(store, { paperLimit: 0 })
    check('engines.node.ok = true', state.engines?.node?.ok === true, JSON.stringify(state.engines?.node))
    check('engines.node.runtime 是当前版本', state.engines?.node?.runtime === process.versions.node)
    check('engines.node.declared 正确', state.engines?.node?.declared === REQUIRED_NODE_RANGE)
    check('engines.dsh.declared 正确', state.engines?.dsh?.declared === REQUIRED_DSH_RANGE)
    check('engines.dsh 标记 host-loader', state.engines?.dsh?.enforcedBy === 'host-loader')
    const snapshot = engineStateOf(process.versions.node)
    check('engineStateOf 形状稳定', snapshot.node.ok === true && snapshot.dsh.declared === REQUIRED_DSH_RANGE)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(`\n全部通过：${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
