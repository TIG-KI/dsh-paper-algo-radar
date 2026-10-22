/**
 * `/radar` 命令（§8.9）。
 *
 * 只做**控制面**：状态、重算、导出。查询类能力留给工具（命令不是第二套 CLI）。
 *
 * 约定：
 *  - 文本回复**只给人读**；结构化事实由调用方另行发 session event（本版暂未接入投影）。
 *  - 可选依赖：拿不到 `commands` 服务时静默跳过（headless 组合里没有它）。
 *  - 零依赖：不 import `@deepseek-ai/dsh-commands`，`definitionId` 用普通字符串。
 *    注册失败只 warn，不影响插件其余功能。
 *
 * @module paper-algo-radar/command
 */

export const RADAR_USAGE =
  '用法：/radar [status | reextract [--apply] | export [--csv] | report [review|decide|insight] [--days N] [--field 名] [--years A-B]]'

/**
 * @param {object} ctx Cordis 上下文
 * @param {{ status: () => Promise<object>, reextract: (o: object) => Promise<object>, exportFile: (o: object) => Promise<object>, report: (o: object) => Promise<object> }} api
 */
export function registerRadarCommand(ctx, api) {
  const injectFn = ctx?.inject
  if (typeof injectFn !== 'function') return false

  injectFn.call(ctx, ['commands'], (commandCtx) => {
    const registry = commandCtx?.commands
    if (registry === undefined || typeof registry.register !== 'function') {
      api.onSkipped?.('commands 服务没有 register 方法')
      return
    }

    try {
      registry.register({
        definitionId: 'dsh-paper-algo-radar/radar',
        name: 'radar',
        description: '论文算法雷达：查看状态、原地重算旧口径、导出数据、生成 Markdown 报告',
        input: { hint: 'status | reextract [--apply] | export [--csv] | report [review|decide]' },
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? '').trim()
          const words = raw.split(/\s+/).filter(Boolean)
          const sub = (words[0] ?? '').toLowerCase()
          const flags = new Set(words.slice(1).map((w) => w.toLowerCase()))

          try {
            if (sub === '' || sub === 'status') {
              const info = await api.status()
              const lines = [
                `算法雷达 · ${info.paperCount} 篇论文 / ${info.algorithmCount} 个算法 / ${info.mentionCount} 次提及`,
                `口径 ${info.dictVersion} · 快照 v${info.schemaVersion} · 库 ${Math.round(info.dbBytes / 1024)} KB`,
              ]
              if (info.abstractOnlyCount > 0) lines.push(`其中 ${info.abstractOnlyCount} 篇仅摘要`)
              if (info.stalePapers > 0) {
                lines.push(
                  info.staleRecomputable > 0
                    ? `旧口径 ${info.stalePapers} 篇（其中 ${info.staleRecomputable} 篇可原地重算）`
                    : `旧口径 ${info.stalePapers} 篇，但都没有留存正文，无法重算`,
                )
              }
              return { kind: 'success', text: lines.join('\n') }
            }

            if (sub === 'reextract') {
              const apply = flags.has('--apply') || flags.has('-a')
              const result = await api.reextract({ scope: 'stale', dryRun: !apply })
              const head = apply
                ? `已重算：${result.total} 篇里 ${result.changed} 篇有变化`
                : `预览（未写库）：${result.total} 篇里 ${result.changed} 篇会变`
              const lines = [head]
              if (result.skippedNoText > 0) lines.push(`${result.skippedNoText} 篇没有留存正文，已跳过`)
              if (!apply && result.changed >= 0) lines.push('确认无误后执行：/radar reextract --apply')
              return { kind: 'success', text: lines.join('\n') }
            }

            if (sub === 'export') {
              const format = flags.has('--csv') ? 'csv' : 'json'
              const result = await api.exportFile({ format, includeText: 0 })
              return {
                kind: 'success',
                text: `已导出 ${String(result.format).toUpperCase()}：${Math.round((result.bytes / 1024) * 10) / 10} KB\n路径：${result.path}`,
              }
            }

            if (sub === 'report') {
              const rest = words.slice(1)
              const mode = rest.includes('decide') || flags.has('--decide')
                ? 'decide'
                : rest.includes('insight') || flags.has('--insight')
                  ? 'insight'
                  : 'review'
              const dayIndex = rest.findIndex((w) => w === '--days')
              const fieldIndex = rest.findIndex((w) => w === '--field')
              const yearsIndex = rest.findIndex((w) => w === '--years')
              const options = { mode }
              if (dayIndex >= 0 && Number.isFinite(Number(rest[dayIndex + 1]))) options.windowDays = Number(rest[dayIndex + 1])
              if (fieldIndex >= 0 && rest[fieldIndex + 1] !== undefined) {
                options.scope = 'field'
                options.field = rest[fieldIndex + 1]
              }
              if (yearsIndex >= 0 && typeof rest[yearsIndex + 1] === 'string') {
                const [from, to] = rest[yearsIndex + 1].split('-')
                options.scope = 'yearRange'
                if (Number.isFinite(Number(from))) options.yearFrom = Number(from)
                if (Number.isFinite(Number(to))) options.yearTo = Number(to)
              }
              const result = await api.report(options)
              const titles = result.sections.map((s) => `${s.n}. ${s.title}`).join(' / ')
              return {
                kind: 'success',
                text:
                  `已生成${result.mode === 'decide' ? '决策' : result.mode === 'insight' ? '洞察' : '汇报'}报告（${result.scope}，${Math.round((result.bytes / 1024) * 10) / 10} KB）\n` +
                  `路径：${result.path}\n章节：${titles}`,
              }
            }

            return { kind: 'error', text: RADAR_USAGE }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        },
      })
      api.onRegistered?.()
      return true
    } catch (error) {
      const warn = ctx?.logger?.warn
      if (typeof warn === 'function') warn.call(ctx.logger, `/radar 命令注册失败：${error?.message ?? error}`)
      api.onSkipped?.(`注册抛错：${error?.message ?? error}`)
      return false
    }
  })

  return true
}
