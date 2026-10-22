/**
 * W1-05 验收：`/radar` 命令（§8.9）。
 *
 * 用假 ctx 捕获注册项，直接调 handler —— 不需要真宿主。
 * 运行：node test/command.test.mjs
 */
import { registerRadarCommand, RADAR_USAGE } from '../lib/command.js'

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

function fakeCtx(options = {}) {
  const registered = []
  const warnings = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')), info() {}, error() {} },
    inject(services, fn) {
      if (options.withCommands === false) return () => {}
      if (!services.includes('commands')) return () => {}
      fn({
        commands: {
          register(definition) {
            if (options.registerThrows) throw new Error('registry broken')
            registered.push(definition)
            return () => {}
          },
        },
      })
      return () => {}
    },
  }
  return { ctx, registered, warnings }
}

const calls = []
const api = {
  status: async () => ({
    paperCount: 5,
    algorithmCount: 13,
    mentionCount: 124,
    abstractOnlyCount: 4,
    dictVersion: '2026.10.1',
    schemaVersion: 2,
    dbBytes: 33700,
    stalePapers: 5,
    staleRecomputable: 0,
  }),
  reextract: async (options) => {
    calls.push({ what: 'reextract', options })
    return { total: 5, changed: 0, skippedNoText: 5 }
  },
  exportFile: async (options) => {
    calls.push({ what: 'export', options })
    return { path: 'C:/tmp/radar.json', bytes: 2048, format: options.format }
  },
}

console.log('\n[1] 注册')
{
  const { ctx, registered } = fakeCtx()
  registerRadarCommand(ctx, api)
  check('注册了一个命令', registered.length === 1)
  check('名字是 radar', registered[0].name === 'radar', registered[0]?.name)
  check('带 definitionId', registered[0].definitionId === 'dsh-paper-algo-radar/radar')
  check('声明了 input.hint', typeof registered[0].input?.hint === 'string' && registered[0].input.hint.length > 0)
  check('有 handler', typeof registered[0].handler === 'function')
}

const run = async (rawInput, customApi = api) => {
  const { ctx, registered } = fakeCtx()
  registerRadarCommand(ctx, customApi)
  return registered[0].handler({ rawInput, signal: undefined })
}

console.log('\n[2] /radar 与 /radar status')
{
  const bare = await run('')
  check('裸命令返回 success', bare.kind === 'success')
  check('文本里有规模', bare.text.includes('5 篇论文') && bare.text.includes('124 次提及'), bare.text)
  check('文本里有口径', bare.text.includes('2026.10.1'))
  const withStatus = await run('status')
  check('status 等价于裸命令', withStatus.kind === 'success' && withStatus.text === bare.text)
  check('提示「都没有留存正文」', bare.text.includes('无法重算'), bare.text)
}

console.log('\n[3] /radar reextract —— 默认只预览')
{
  calls.length = 0
  const preview = await run('reextract')
  check('默认 dryRun=true', calls[0]?.options?.dryRun === true, JSON.stringify(calls[0]))
  check('scope 是 stale', calls[0]?.options?.scope === 'stale')
  check('文本说明是预览', preview.text.includes('预览'), preview.text)
  check('提示下一步加 --apply', preview.text.includes('--apply'), preview.text)

  calls.length = 0
  const applied = await run('reextract --apply')
  check('--apply 时 dryRun=false', calls[0]?.options?.dryRun === false, JSON.stringify(calls[0]))
  check('文本说明已重算', applied.text.includes('已重算'), applied.text)
  check('报告跳过篇数', applied.text.includes('没有留存正文'), applied.text)
}

console.log('\n[4] /radar export')
{
  calls.length = 0
  const json = await run('export')
  check('默认 json', calls[0]?.options?.format === 'json', JSON.stringify(calls[0]))
  check('文本给路径与体积', json.text.includes('路径') && json.text.includes('KB'), json.text)

  calls.length = 0
  const csv = await run('export --csv')
  check('--csv 切格式', calls[0]?.options?.format === 'csv', JSON.stringify(calls[0]))
}

console.log('\n[5] 未知子命令与错误')
{
  const bad = await run('whatever')
  check('未知子命令回 error', bad.kind === 'error')
  check('回用法提示', bad.text === RADAR_USAGE, bad.text)

  const failingApi = { ...api, status: async () => { throw new Error('库损坏') } }
  const failed = await run('status', failingApi)
  check('api 抛错时回 error 而不是抛出去', failed.kind === 'error', JSON.stringify(failed))
  check('错误文本是人话', failed.text.includes('库损坏'), failed.text)
}

console.log('\n[6] 依赖缺失与注册失败都不影响插件')
{
  const { ctx } = fakeCtx({ withCommands: false })
  let threw = false
  try {
    registerRadarCommand(ctx, api)
  } catch {
    threw = true
  }
  check('没有 commands 服务时不抛', threw === false)

  const { ctx: ctx2, registered, warnings } = fakeCtx({ registerThrows: true })
  let threw2 = false
  try {
    registerRadarCommand(ctx2, api)
  } catch {
    threw2 = true
  }
  check('注册抛错时不炸（只 warn）', threw2 === false)
  check('warn 了原因', warnings.some((w) => w.includes('/radar 命令注册失败')), JSON.stringify(warnings))
  check('确实没注册上', registered.length === 0)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
