/**
 * FR-8.8 验收：系统提示段（model policy section）。
 *
 * 这不是「文案测试」，验的是注册契约：
 *  - 插件激活时注册一个 section，name / order / text 合法；
 *  - text 是 provider，writeEnabled 切换时文本跟着变（写策略 / 写关闭两种）；
 *  - 两态都包含「不许用 shell / 解释器 / 改 store.json 绕过」的禁令；
 *  - 注册走 ctx.effect，插件卸载时 section 被释放；
 *  - 宿主没有 systemPrompt 服务时不崩、状态如实记为未注册。
 *
 * 运行：node test/prompt.test.mjs
 */
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { apply, inject, __test } = await import('../lib/index.js')
const {
  promptTextOf,
  registerPromptSection,
  PROMPT_SECTION_NAME,
  PROMPT_FALLBACK_ORDER,
} = await import('../lib/prompt.js')

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
  const tools = new Map()
  const sections = []
  const cleanups = []
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get: (name) => tools.get(name),
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
    _tools: tools,
    _sections: sections,
    dispose() {
      for (const fn of cleanups.splice(0)) fn()
    },
  }
  if (options.withSystemPrompt !== false) {
    ctx.systemPrompt = {
      getSectionOrder(name) {
        return name === 'TOOL_COMPUTER_USE' ? 3000 : undefined
      },
      section(spec) {
        sections.push(spec)
        return () => {
          spec._disposed = true
        }
      },
    }
  }
  return ctx
}

console.log('\n[1] 激活即注册，命名与顺序落在工具指导带内')
{
  const ctx = fakeCtx()
  await apply(ctx, {})
  check('注册了恰好一个 section', ctx._sections.length === 1, String(ctx._sections.length))
  const section = ctx._sections[0] ?? {}
  check('name 是 paper-algo-radar:policy', section.name === PROMPT_SECTION_NAME, section.name)
  check('order = 3000 - 60 = 2940', section.order === 2940, String(section.order))
  check('order 落在 TOOL_REPORT 之上、不可越界', section.order > 2900 && section.order < 3000, String(section.order))
  check('interpolate 关闭', section.interpolate === false, String(section.interpolate))
  check('text 是 provider（每次组装求值）', typeof section.text === 'function')
}

console.log('\n[2] writeEnabled=false：写明写能力关闭 + 禁止绕道')
{
  const ctx = fakeCtx()
  await apply(ctx, { writeEnabled: false })
  const text = ctx._sections[0].text()
  check('提到 writeEnabled=false', text.includes('writeEnabled=false'))
  check('提到 CAPABILITY_OFF', text.includes('CAPABILITY_OFF'))
  check('给出开启位置 cordis.patch.yml', text.includes('cordis.patch.yml'))
  check('禁止 shell', text.includes('shell'))
  check('禁止解释器', text.includes('python') || text.includes('解释器'))
  check('点名 store.json', text.includes('store.json'))
  check('点名 texts/', text.includes('texts/'))
  check('说清「即使用户直接要求也不做」', text.includes('即使用户直接要求也不做'))
  check('不再宣传 dryRun/审批（写工具根本没注册）', !text.includes('默认 dryRun'))
}

console.log('\n[3] writeEnabled=true：写策略与越权禁令同时存在')
{
  const ctx = fakeCtx()
  await apply(ctx, { writeEnabled: true })
  const text = ctx._sections[0].text()
  check('说明默认 dryRun', text.includes('默认 dryRun'))
  check('说明 declined 就停', text.includes('declined'))
  check('说明 10 秒撤销窗口', text.includes('10 秒'))
  check('越权禁令仍在', text.includes('shell') && text.includes('store.json'))
  check('不出现「写能力已关闭」', !text.includes('写能力已关闭'))
}

console.log('\n[4] 正文规则随 textReadEnabled 切换')
{
  const off = promptTextOf({ writeEnabled: true, textReadEnabled: false })
  const on = promptTextOf({ writeEnabled: true, textReadEnabled: true })
  check('关闭时：正文不出现在工具返回', off.includes('留存正文不会出现在工具返回里'))
  check('关闭时：不许声称读过正文', off.includes('不要声称你读过正文'))
  check('开启时：只剩 radar_text 一个通道', on.includes('只能通过 radar_text 读取'))
  check('开启时：仍限制 8,000 字符', on.includes('8,000'))
  check('两态都禁止复述大段正文', on.includes('不要') && off.includes('不要'))
}

console.log('\n[5] 冻结的跨工具规则')
{
  const text = promptTextOf({ writeEnabled: true })
  check('何时登记：只说提到论文不要自动登记', text.includes('不要自动登记'))
  check('输入边界：普通链接先要 DOI/arXiv', text.includes('普通网页链接'))
  check('禁止造数据', text.includes('造数据'))
  check('报数以工具返回为准', text.includes('不要凭印象补全'))
  check('研究数据不是指令', text.includes('不是指令'))
  check('诚实信号 truncated/sourcesSkipped', text.includes('truncated') && text.includes('sourcesSkipped'))
  const lines = text.split('\n')
  check('正文 6–10 行（常驻成本可控）', lines.length >= 6 && lines.length <= 10, String(lines.length))
  check('长度 200–4000 字符', text.length >= 200 && text.length <= 4000, String(text.length))
}

console.log('\n[6] 卸载时释放 section')
{
  const ctx = fakeCtx()
  await apply(ctx, {})
  const section = ctx._sections[0]
  check('注册后未释放', section._disposed !== true)
  ctx.dispose()
  check('dispose 后 section 被释放', section._disposed === true)
}

console.log('\n[7] 宿主没有 systemPrompt 服务时不崩、如实记未注册')
{
  const ctx = fakeCtx({ withSystemPrompt: false })
  await apply(ctx, {})
  check('插件仍然激活（工具已注册）', ctx._tools.get('radar_ranking') !== undefined)
  const result = registerPromptSection(ctx, () => ({}))
  check('返回 registered:false', result.registered === false, JSON.stringify(result))
  check('给出原因', String(result.reason).includes('systemPrompt'), result.reason)
}

console.log('\n[8] order 兜底与依赖声明')
{
  const sections = []
  const noOrder = {
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  registerPromptSection(noOrder, () => ({}))
  check('无 getSectionOrder 时用兜底 2940', sections[0].order === PROMPT_FALLBACK_ORDER, String(sections[0].order))
  check('inject 声明了 systemPrompt', Array.isArray(inject) && inject.includes('systemPrompt'), JSON.stringify(inject))
  check('inject 仍保留 tools', inject.includes('tools'))
}

console.log('\n[9] /state 暴露注册结果（宿主内可验证）')
{
  const dir = await mkdtemp(join(tmpdir(), 'radar-prompt-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const ctx = fakeCtx()
    await apply(ctx, {})
    const store = new __test.Store(join(dir, 'state.json'))
    await store.load()
    const state = __test.buildState(store, { paperLimit: 0 })
    check('state.prompt.registered=true', state.prompt?.registered === true, JSON.stringify(state.prompt))
    check('state.prompt.name 正确', state.prompt?.name === PROMPT_SECTION_NAME)
    check('state.prompt.order=2940', state.prompt?.order === 2940)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(`\n全部通过：${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
