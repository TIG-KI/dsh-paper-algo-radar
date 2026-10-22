/**
 * T-18 + T-09 验收：
 *  - `apply()` 加载期零副作用（不读盘、不写盘、不探测，FR-10.5）；
 *  - `radar_status` 的口径 / 规模 / 体积 / 旧口径统计。
 *
 * 用假 ctx 直接跑 apply()，不依赖宿主。
 * 运行：node test/status.test.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const { apply } = await import('../lib/index.js')
const { READ_TOOL_NAMES, WRITE_TOOL_NAMES } = await import('../lib/contract.js')

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
  return {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // 模拟「没有 webServer」的宿主：inject 不回调
    inject() {
      return () => {}
    },
    logger: { warn() {}, info() {}, error() {} },
    _tools: tools,
  }
}

const dir = await mkdtemp(join(tmpdir(), 'radar-status-'))
const storeDir = join(dir, 'plugin-data', 'paper-algo-radar')
const storeFile = join(storeDir, 'store.json')

// 预先放一份 v0.2 快照（version:1），证明 apply 不会主动去读它
await mkdir(storeDir, { recursive: true })
const legacy = {
  version: 1,
  savedAt: '2026-01-01T00:00:00.000Z',
  papers: {
    p_0123456789abcdef: {
      id: 'p_0123456789abcdef',
      title: 'Legacy',
      chars: 5000,
      depth: 'fulltext',
      fields: ['NLP'],
      readAt: 1,
      updatedAt: 2,
    },
  },
  algorithms: { transformer: { id: 'transformer', name: 'Transformer', type: 'DL' } },
  mentions: {
    'p_0123456789abcdef::transformer': {
      paperId: 'p_0123456789abcdef',
      algorithmId: 'transformer',
      count: 7,
      sections: { method: 7 },
    },
  },
  meta: { state: { schemaVersion: 1 } },
}
const original = JSON.stringify(legacy)
await writeFile(storeFile, original, 'utf8')

const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = dir

try {
  console.log('\n[1] apply 不碰磁盘')
  const ctx = fakeCtx()
  await apply(ctx)
  const filesAfterApply = await readdir(storeDir)
  check('加载后目录里仍只有 store.json', filesAfterApply.length === 1 && filesAfterApply[0] === 'store.json', filesAfterApply.join(','))
  check('没有生成 .bak', !filesAfterApply.some((f) => f.endsWith('.bak')))
  check('没有生成 .tmp', !filesAfterApply.some((f) => f.endsWith('.tmp')))
  const afterApply = await readFile(storeFile, 'utf8')
  check('文件内容一字节未变（没写盘）', afterApply === original)
  check('仍是 version 1（没被迁移落盘）', JSON.parse(afterApply).version === 1)

  console.log('\n[2] 工具全注册')
  const all = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]
  // 数量跟着常量走，不写死——否则每加一个工具就要改一次测试
  check(`命名常量共 ${all.length} 个`, all.length >= 7, String(all.length))
  check('每个工具都在注册表里', all.every((name) => ctx._tools.get(name) !== undefined), [...ctx._tools.keys()].join(','))
  check('名字与注册表一致', [...ctx._tools.keys()].sort().join(',') === [...all].sort().join(','))

  console.log('\n[3] radar_status 触发惰性打开')
  const status = ctx._tools.get('radar_status')
  const value = await status.execute({})
  check('拿到论文数', value.paperCount === 1, String(value.paperCount))
  check('拿到算法数', value.algorithmCount === 1, String(value.algorithmCount))
  check('拿到提及数', value.mentionCount === 7, String(value.mentionCount))
  check('带口径版本', typeof value.dictVersion === 'string' && value.dictVersion.length > 0)
  check('带快照版本 2（已在内存里迁移）', value.schemaVersion === 2, String(value.schemaVersion))
  check('统计出旧口径提及 1 条', value.staleMentions === 1, String(value.staleMentions))
  check('带数据文件路径', typeof value.storeFile === 'string' && value.storeFile.endsWith('store.json'))
  check('带库体积（>0）', typeof value.dbBytes === 'number' && value.dbBytes > 0, String(value.dbBytes))
  check('带已注册工具清单', Array.isArray(value.tools) && value.tools.length === all.length, JSON.stringify(value.tools))
  check('带能力标记', value.capabilities?.write === true && value.capabilities?.textRead === false)
  check('带迁移报告', value.migration?.fromVersion === 1 && value.migration?.toVersion === 2)

  console.log('\n[4] status 卡片')
  const card = status.output.render({}, value).map((b) => b.text).join('\n')
  check('卡片含规模', card.includes('1 篇论文') && card.includes('7 次提及'), card.split('\n')[0])
  check('卡片含口径', card.includes(value.dictVersion))
  check('卡片提示旧口径', card.includes('旧口径'), card)

  console.log('\n[5] 数据文件损坏时 apply 仍不抛')
  await writeFile(storeFile, '{ 这不是 JSON', 'utf8')
  const ctx2 = fakeCtx()
  let threw = false
  try {
    await apply(ctx2)
  } catch {
    threw = true
  }
  check('apply 不抛（错误推迟到真正用到存储时）', threw === false)
  let toolThrew = false
  try {
    await ctx2._tools.get('radar_status').execute({})
  } catch {
    toolThrew = true
  }
  check('调用工具时才报错', toolThrew === true)
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
