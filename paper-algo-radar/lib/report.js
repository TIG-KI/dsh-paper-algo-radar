/**
 * 研究报告渲染（§7 FR-13 / §8 R13 / docs/REPORT_TEMPLATE_SPEC.md）。
 *
 * **纯函数**：输入一份结构化快照（由 index.js 的 collectReportData 采集），
 * 输出 Markdown 文本与章节标题列表。不读盘、不联网、不调模型、不看当前时间——
 * 所有时间都来自参数，这是 E26（同参数两次生成必须字节一致）的前提。
 *
 * 两个模式：
 *  - `review` 汇报：10 章（摘要 / 数据画像 / 排行 / 类型 / 时间线 / 领域 / 代表论文 / 最近新增 / 可信度 / 附录）
 *  - `decide` 决策：5 章（缺口 / 缺口证据 / 方向与动作 / 口径附录 / 未评估项）
 *
 * 缺口规则全是「阈值 + 计数」，无模型判断（R13.10）。
 *
 * @module paper-algo-radar/report
 */

export const REVIEW_CHAPTERS = [
  '摘要',
  '数据画像',
  '算法排行 Top 10',
  '类型分布',
  '时间线',
  '领域分布',
  '代表性论文',
  '最近新增',
  '可信度与局限',
  '附录',
]

export const DECIDE_CHAPTERS = ['缺口清单', '缺口证据', '方向与动作', '口径附录', '未评估项']

/** 缺口编号 → 名称与默认严重度（FEATURE_REPORT §5 的映射，D1 §3 只给了阈值）。 */
export const GAP_DEFS = {
  G1: { name: '输入质量欠账', severity: '高' },
  G2: { name: '领域过薄', severity: '中' },
  G3: { name: '类型失衡', severity: '中' },
  G4: { name: '时间断层', severity: '中' },
  G5: { name: '口径陈旧', severity: '低' },
}

/** 缺口默认参数（D1 §3）。 */
export const GAP_DEFAULTS = {
  abstractRatio: 0.5,
  libraryMinForTypes: 20,
  typeShareMin: 0.1,
  libraryMinForYears: 5,
  yearLag: 2,
}

/* ------------------------------------------------------------------ *
 * 格式化（§0.2）
 * ------------------------------------------------------------------ */

/** 计数：整数、无千分位；未知用 —。 */
export function fmtCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return String(Math.trunc(Number(value)))
}

/** 百分比：1 位小数；分母 0 或未知 → —。 */
export function fmtPct(numerator, denominator) {
  const n = Number(numerator)
  const d = Number(denominator)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return '—'
  return `${((n / d) * 100).toFixed(1)}%`
}

/** 年份：null → —。 */
export function fmtYear(year) {
  return typeof year === 'number' && Number.isFinite(year) ? String(Math.trunc(year)) : '—'
}

/** 本地时间 `YYYY-MM-DD HH:mm`。 */
export function fmtDateTime(ms) {
  const d = new Date(ms)
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文件名时间戳 `YYYYMMDD-HHmm`。 */
export function fmtStamp(ms) {
  const d = new Date(ms)
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 表格单元格转义：竖线与换行会破坏 Markdown 表格。 */
export function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** 数字列表头右对齐（§0.3）。 */
function table(headers, rows, rightAligned = []) {
  const head = `| ${headers.map((h, i) => (rightAligned.includes(i) ? `${h}` : h)).join(' | ')} |`
  const sep = `| ${headers.map((_, i) => (rightAligned.includes(i) ? '---:' : '---')).join(' | ')} |`
  const body = rows.map((row) => `| ${row.map(cell).join(' | ')} |`)
  return [head, sep, ...body]
}

/* ------------------------------------------------------------------ *
 * 章节渲染
 * ------------------------------------------------------------------ */

/** 报告头（§0.5，不计章）。 */
export function renderHeader(data) {
  const c = data.counts
  const title = data.mode === 'decide' ? '决策报告' : data.mode === 'insight' ? '领域洞察报告' : '汇报报告'
  const scale =
    data.mode === 'insight' && data.library !== undefined
      ? `全库 ${fmtCount(data.library.papers)} 篇；本领域 ${fmtCount(c.papers)} 篇`
      : `${fmtCount(c.papers)} 篇`
  const lines = [
    `# 论文算法雷达 · ${title}`,
    `生成：${fmtDateTime(data.generatedAt)}（${data.timeZone}） · 口径 ${data.dictVersion} · 参考年 ${data.referenceYear}`,
    `库：${scale} · ${fmtCount(c.algorithms)} 个算法 · ${fmtCount(c.mentions)} 次提及 · ` +
      `摘要级 ${fmtCount(c.abstract)}/${fmtCount(c.papers)} · 陈旧 ${fmtCount(c.stalePapers)} 篇 · ` +
      `可重算 ${fmtCount(c.staleRecomputable)} 篇`,
    `范围：${data.scope.label}`,
  ]
  if (data.narrative === 1) {
    lines.push('')
    lines.push('> 本报告含模型待补写段落（P-10：插件不持有模型句柄，占位块由会话模型补写）。')
  }
  return lines
}

/** 来源构成文案（D-1）：7 类按篇数降序，为 0 省略；null 另写「未知 N 篇」。 */
export function fmtSourceComposition(sourceCounts) {
  const order = ['pdf', 'doi', 'arxiv', 'manual', 'zotero', 'search', 'skill']
  const rows = order
    .map((name) => ({ name, count: Number(sourceCounts?.[name] ?? 0) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
  const parts = rows.map((row) => `${row.name} ${row.count}`)
  const unknown = Number(sourceCounts?.null ?? 0)
  if (unknown > 0) parts.push(`未知 ${unknown} 篇`)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/** 阅读状态折叠（D-2）：done=已读；toread+reading=未读（在读单列注明）；null=未知。 */
export function foldStatus(statusCounts) {
  const done = Number(statusCounts?.done ?? 0)
  const toread = Number(statusCounts?.toread ?? 0)
  const reading = Number(statusCounts?.reading ?? 0)
  const unknown = Number(statusCounts?.null ?? 0)
  return { done, toread, reading, unread: toread + reading, unknown }
}

/** 第 1 章 摘要（review，3–5 条数字陈述）。 */
export function renderSummary(data) {
  const c = data.counts
  const lines = []
  const top = data.algorithms[0]
  if (c.papers > 0) {
    lines.push(
      `- 共登记 ${fmtCount(c.papers)} 篇（全文 ${fmtCount(c.fulltext)} / 摘要 ${fmtCount(c.abstract)}），` +
        `覆盖 ${fmtCount(c.algorithms)} 个算法、${fmtCount(c.fields)} 个领域。`,
    )
  }
  if (top !== undefined) {
    lines.push(
      `- 出现最多的是 \`${top.name}\`（${fmtCount(top.papers)} 篇 / ${fmtCount(top.mentions)} 次，` +
        `覆盖 ${fmtPct(top.papers, c.papers)}）。`,
    )
  }
  if (data.timeline.firstYear !== null) {
    lines.push(
      `- 时间跨度 ${data.timeline.firstYear}–${data.timeline.lastYear}；无年份 ${fmtCount(data.timeline.undated)} 篇。`,
    )
  } else if (c.papers > 0) {
    lines.push(`- 无年份论文 ${fmtCount(data.timeline.undated)} 篇，时间跨度 —。`)
  }
  if (c.papers > 0) {
    const ratio = c.abstract / c.papers
    const tail = ratio > 0.5 ? '；摘要级过半，排行可能偏差' : ''
    lines.push(`- 输入质量：摘要级 ${fmtPct(c.abstract, c.papers)}${tail}。`)
  }
  lines.push(
    `- 口径 \`${data.dictVersion}\`；陈旧 ${fmtCount(c.stalePapers)} 篇（可重算 ${fmtCount(c.staleRecomputable)} 篇）。`,
  )
  return { n: 1, title: '摘要', lines: lines.slice(0, 5) }
}

/** 第 2 章 数据画像（review）。 */
export function renderProfile(data) {
  const c = data.counts
  const span = data.timeline.firstYear === null ? '—' : `${data.timeline.firstYear}–${data.timeline.lastYear}`
  const rows = [
    ['论文数', `${fmtCount(c.papers)} 篇`],
    ['全文级 / 摘要级', `${fmtCount(c.fulltext)} / ${fmtCount(c.abstract)}`],
    ['算法数', fmtCount(c.algorithms)],
    ['领域数', fmtCount(c.fields)],
    ['提及总数', `${fmtCount(c.mentions)} 次`],
    ['时间跨度', span],
    ['词典口径', data.dictVersion],
    ['陈旧提及', `${fmtCount(c.staleMentions)} 条`],
    ['可重算论文', `${fmtCount(c.staleRecomputable)} 篇`],
    ['无正文论文', `${fmtCount(c.noText)} 篇`],
    ['无年份论文', `${fmtCount(data.timeline.undated)} 篇`],
    // D-1：来源构成 / 已读未读 / 状态未知（三行之和 = 论文总数）
    ['来源构成', fmtSourceComposition(data.sourceCounts)],
    [
      '已读 / 未读',
      (() => {
        const folded = foldStatus(data.statusCounts)
        const tail = folded.reading > 0 ? `（在读 ${folded.reading} 篇）` : ''
        return `${fmtCount(folded.done)} / ${fmtCount(folded.unread)}${tail}`
      })(),
    ],
    ['状态未知', `${fmtCount(foldStatus(data.statusCounts).unknown)} 篇`],
  ]
  return { n: 2, title: '数据画像', lines: table(['指标', '值'], rows) }
}

/** 第 3 章 算法排行 Top 10（review）。 */
export function renderRanking(data) {
  const top = data.algorithms.slice(0, 10)
  const lines = []
  if (top.length === 0) {
    lines.push('本次范围内没有算法记录。')
  } else {
    const rows = top.map((a, i) => [
      i + 1,
      a.family ? `${a.name}（${a.type} · ${a.family}）` : `${a.name}（${a.type}）`,
      a.papers,
      a.mentions,
      fmtPct(a.papers, data.counts.papers),
      fmtYear(a.firstYear),
    ])
    lines.push(...table(['#', '算法', '论文数', '提及数', '覆盖率', '首见年'], rows, [0, 2, 3, 4, 5]))
    lines.push('')
    lines.push(`> 分母 = ${fmtCount(data.counts.papers)} 篇（scope 内）。覆盖率 = 命中论文数 ÷ 分母。`)
    if (data.staleMentionsInTop > 0) {
      lines.push(`> 含旧口径数据 ${fmtCount(data.staleMentionsInTop)} 条（dictVersion 混合，跨版本比较需谨慎）。`)
    }
    // D-1 / FR-14.4：排行默认包含未读论文，必须在表下标清楚
    const foldedRank = foldStatus(data.statusCounts)
    if (foldedRank.unread > 0) {
      lines.push(`> 排行含未读 ${fmtCount(foldedRank.unread)} 篇（toread + reading），未按阅读状态过滤。`)
    }
    const pointer = data.snippetPointers ?? []
    if (pointer.length > 0) {
      lines.push(`> 证据片段只给定位符（正文不进入报告）：${pointer.join('；')}。`)
    }
  }
  return { n: 3, title: '算法排行 Top 10', lines }
}

/** 第 4 章 类型分布（review，多标签口径）。 */
export function renderTypeDistribution(data) {
  const total = data.typeDist.reduce((sum, row) => sum + row.papers, 0)
  // §1.4：固定三行 DL / ML / MATH，为 0 也显示；分母 = 三行之和（不是论文数）
  const rows = data.typeDist.map((row) => [row.type, row.papers, fmtPct(row.papers, total)])
  const lines = [
    ...table(['类型', '论文数', '占比'], rows, [1, 2]),
    '',
    `> 一篇论文可跨多个类型，故合计大于论文数（分母=${fmtCount(total)}）。`,
  ]
  return { n: 4, title: '类型分布', lines }
}

/** 第 5 章 时间线（review）。 */
export function renderTimeline(data) {
  const lines = []
  if (data.timeline.years.length === 0) {
    lines.push('范围内没有带年份的论文。')
  } else {
    const rows = data.timeline.years.map((row) => [row.year, row.newPapers, row.cumulative])
    lines.push(...table(['年份', '新增论文', '累计论文'], rows, [0, 1, 2]))
    lines.push('')
    const algoRows = data.algorithmYears
      .slice(0, 10)
      .map((a) => [a.name, fmtYear(a.first), fmtYear(a.last)])
    if (algoRows.length > 0) {
      lines.push('')
      lines.push(...table(['算法', '首见', '最近'], algoRows, [1, 2]))
    }
    if (data.timeline.undated > 0) {
      lines.push(`> 另有 ${fmtCount(data.timeline.undated)} 篇无年份论文未计入（undatedCount）。`)
    }
  }
  return { n: 5, title: '时间线', lines }
}

/** 第 6 章 领域分布（review，未分类单列最后）。 */
export function renderFieldDistribution(data) {
  const den = data.counts.papers
  const rows = data.fields.map((row) => [row.field, row.count, fmtPct(row.count, den)])
  if (data.unclassified > 0) rows.push(['未分类', data.unclassified, fmtPct(data.unclassified, den)])
  const lines = rows.length === 0
    ? ['本次范围内没有领域标签。']
    : [
        ...table(['领域', '论文数', '占比'], rows, [1, 2]),
        '',
        `> 论文可多标签，合计可能大于论文数（分母=${fmtCount(den)}）。`,
      ]
  return { n: 6, title: '领域分布', lines }
}

/** 第 7 章 代表性论文（review）。 */
export function renderRepresentativePapers(data) {
  const perField = data.fields.length <= 2 ? 3 : 2
  const groups = []
  for (const f of data.fields) {
    const list = data.papers
      .filter((p) => (p.fields ?? []).includes(f.field))
      .sort((a, b) => b.hitCount - a.hitCount || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, perField)
    for (const p of list) groups.push([f.field, p])
  }
  if (data.unclassified > 0) {
    const list = data.papers
      .filter((p) => (p.fields ?? []).length === 0 || (p.fields ?? []).every((x) => x === '未分类'))
      .sort((a, b) => b.hitCount - a.hitCount || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, perField)
    for (const p of list) groups.push(['未分类', p])
  }
  const capped = groups.slice(0, 6)
  const lines = capped.length === 0
    ? ['本次范围内没有可列举的论文。']
    : [
        ...table(
          ['领域', '论文', '年份', '算法数'],
          capped.map(([field, p]) => [
            field,
            p.depth === 'abstract' ? `${p.title}（摘要级）` : p.title,
            fmtYear(p.year),
            p.hitCount,
          ]),
          [2, 3],
        ),
        '',
        '> 按命中算法数选取，偏好长文；仅供参考。',
      ]
  return { n: 7, title: '代表性论文', lines }
}

/** 第 8 章 最近 N 天新增（review，按 readAt）。 */
export function renderRecent(data) {
  const cutoff = data.generatedAt - data.windowDays * 86400000
  const recent = data.papers
    .filter((p) => typeof p.readAt === 'number' && p.readAt >= cutoff)
    .sort((a, b) => b.readAt - a.readAt)
    .slice(0, 10)
  const lines = recent.length === 0
    ? [`最近 ${data.windowDays} 天无新增。`]
    : [
        ...table(
          ['日期', '论文', '算法数'],
          recent.map((p) => [fmtDateTime(p.readAt).slice(0, 10), p.title, p.hitCount]),
          [2],
        ),
        '',
        `> 按登记时间（readAt）统计，区间 ${data.windowDays} 天；重算不会改变登记时间。`,
      ]
  return { n: 8, title: '最近新增', lines }
}

/** 第 9 章 可信度与局限（review），decide 第 4 章复用同一函数（R13: 一字不改）。 */
export function limitationRows(data) {
  const c = data.counts
  const rows = []

  // 摘要级占比
  if (c.papers > 0 && c.abstract < c.papers) {
    rows.push(['摘要级占比', `摘要级 ${fmtCount(c.abstract)}/${fmtCount(c.papers)}（${fmtPct(c.abstract, c.papers)}）；摘要级论文的算法数天然偏少`])
  } else {
    rows.push(['摘要级占比', '无（全部为全文级或空库）'])
  }
  // 样本量
  rows.push(['样本量', c.papers < 20 ? `${fmtCount(c.papers)} 篇 < 20，排行不具统计意义` : `${fmtCount(c.papers)} 篇，样本量可用`])
  // 旧口径
  rows.push([
    '旧口径',
    c.staleMentions > 0
      ? `${fmtCount(c.staleMentions)} 条提及为旧口径，跨版本比较需谨慎`
      : '无旧口径提及',
  ])
  // 无正文
  rows.push([
    '无正文',
    c.noText > 0 ? `${fmtCount(c.noText)} 篇无正文，不可重算（重新登记可补）` : '全部论文均有留存正文',
  ])
  // 领域覆盖
  rows.push([
    '领域覆盖',
    c.fields <= 2 ? `领域标签仅 ${fmtCount(c.fields)} 个，分布不可用于推断` : `${fmtCount(c.fields)} 个领域，可用于分布观察`,
  ])
  // 数值口径
  rows.push(['数值口径', '论文数=命中论文篇数；提及数=出现次数；百分比分母随 scope 变化并在当段标注'])

  return rows
}

/** 第 9 章 可信度与局限（review），decide 第 4 章复用同一函数（R13: 一字不改）。 */
export function renderLimitations(data) {
  return { title: '可信度与局限', lines: table(['项目', '说明'], limitationRows(data)) }
}

/** 第 10 章 附录（review）。`maxRows` 是 A/B 两表的总行预算（§0.4 全文 ≤400 行）。 */
export function renderAppendix(data, options = {}) {
  const budget = Number.isFinite(Number(options.maxRows)) ? Math.max(2, Number(options.maxRows)) : 404
  const lines = []
  const algoTotal = data.algorithms.length
  const paperTotal = data.papers.length

  // 预算对半给 A / B，各自再受「≤200 行」约束
  const aCap = Math.min(200, Math.max(0, Math.floor(budget / 2)))
  const bCap = Math.min(200, Math.max(0, budget - aCap))

  lines.push('### A. 完整排行')
  lines.push('')
  const rankRows = data.algorithms.slice(0, aCap).map((a, i) => [i + 1, a.name, a.papers, a.mentions])
  if (rankRows.length === 0) lines.push('（空）')
  else lines.push(...table(['#', '算法', '论文数', '提及数'], rankRows, [0, 2, 3]))
  if (algoTotal > rankRows.length) {
    lines.push('')
    lines.push(`（已截断：显示前 ${rankRows.length} / 共 ${algoTotal}）`)
  }

  lines.push('')
  lines.push('### B. 论文清单')
  lines.push('')
  const paperRows = data.papers
    .slice()
    .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))
    .slice(0, bCap)
    .map((p) => [p.title, fmtYear(p.year), (p.fields ?? []).join('、') || '未分类', p.hitCount])
  if (paperRows.length === 0) lines.push('（空）')
  else lines.push(...table(['标题', '年份', '领域', '算法数'], paperRows, [1, 3]))
  if (paperTotal > paperRows.length) {
    lines.push('')
    lines.push(`（已截断：显示前 ${paperRows.length} / 共 ${paperTotal}）`)
  }
  return { n: 10, title: '附录', lines }
}

/* ------------------------------------------------------------------ *
 * 缺口规则（decide）
 * ------------------------------------------------------------------ */

/**
 * 计算缺口（确定性阈值，无模型判断）。
 * @returns {{id:string,name:string,severity:string,rule:string,evidence:string,hit:boolean,action:string}[]}
 */
export function computeGaps(data, options = {}) {
  const p = { ...GAP_DEFAULTS, ...(options.gapParams ?? {}) }
  const c = data.counts
  const referenceYear = data.referenceYear
  const gaps = []

  // G1 输入质量欠账：摘要级占比 > 50% 或 无正文 > 0
  {
    const ratio = c.papers > 0 ? c.abstract / c.papers : 0
    const hit = c.papers > 0 && (ratio > p.abstractRatio || c.noText > 0)
    gaps.push({
      id: 'G1',
      name: GAP_DEFS.G1.name,
      severity: GAP_DEFS.G1.severity,
      rule: `摘要级占比 > ${(p.abstractRatio * 100).toFixed(0)}%，或 无正文篇数 > 0`,
      evidence: `摘要级 ${fmtCount(c.abstract)}/${fmtCount(c.papers)}（${fmtPct(c.abstract, c.papers)}）；无正文 ${fmtCount(c.noText)} 篇`,
      hit,
      action: '补全文（列可补清单）',
    })
  }

  // G2 领域过薄：1 篇不评估 / 2 篇薄 / ≥3 正常；未分类不计入
  {
    const thin = data.fields.filter((f) => f.count === 2).map((f) => f.field)
    const single = data.fields.filter((f) => f.count === 1).map((f) => f.field)
    const hit = thin.length > 0
    gaps.push({
      id: 'G2',
      name: GAP_DEFS.G2.name,
      severity: GAP_DEFS.G2.severity,
      rule: '领域分级：1 篇不评估 / 2 篇薄 / ≥3 正常（「未分类」不计入）',
      evidence:
        `2 篇的领域 ${thin.length} 个${thin.length > 0 ? '（' + thin.join('、') + '）' : ''}；` +
        `1 篇的领域 ${single.length} 个（不评估）`,
      hit,
      action: thin.length > 0 ? `补该领域（${thin.join('、')}）` : '无',
    })
  }

  // G3 类型失衡：库 ≥20 且某类型占比 < 10%
  {
    const total = data.typeDist.reduce((sum, row) => sum + row.papers, 0)
    const low = data.typeDist
      .filter((row) => total > 0 && row.papers / total < p.typeShareMin)
      .map((row) => `${row.type} ${fmtPct(row.papers, total)}`)
    const hit = c.papers >= p.libraryMinForTypes && low.length > 0
    gaps.push({
      id: 'G3',
      name: GAP_DEFS.G3.name,
      severity: GAP_DEFS.G3.severity,
      rule: `库 ≥ ${p.libraryMinForTypes} 篇且某类型占比 < ${(p.typeShareMin * 100).toFixed(0)}%`,
      evidence:
        c.papers >= p.libraryMinForTypes
          ? `库 ${fmtCount(c.papers)} 篇；低于门槛的类型：${low.length > 0 ? low.join('、') : '无'}`
          : `库 ${fmtCount(c.papers)} 篇 < ${p.libraryMinForTypes}，不评估`,
      hit,
      action: '补该类型基础（需外部检索）',
    })
  }

  // G4 时间断层：库 ≥5 篇且最新论文年 < referenceYear − 2
  {
    const latest = data.timeline.lastYear
    const hit = c.papers >= p.libraryMinForYears && latest !== null && latest < referenceYear - p.yearLag
    gaps.push({
      id: 'G4',
      name: GAP_DEFS.G4.name,
      severity: GAP_DEFS.G4.severity,
      rule: `库 ≥ ${p.libraryMinForYears} 篇且最新论文年 < 参考年 − ${p.yearLag}`,
      evidence:
        latest === null
          ? '无带年份论文，不评估'
          : `最新论文年 ${latest}；参考年 ${referenceYear}；门槛 ${referenceYear - p.yearLag}`,
      hit,
      action: '读新工作',
    })
  }

  // G5 口径陈旧：stalePapers > 0
  {
    const hit = c.stalePapers > 0
    gaps.push({
      id: 'G5',
      name: GAP_DEFS.G5.name,
      severity: GAP_DEFS.G5.severity,
      rule: 'stalePapers > 0',
      evidence: `陈旧 ${fmtCount(c.stalePapers)} 篇（可重算 ${fmtCount(c.staleRecomputable)} 篇）`,
      hit,
      action: '`/radar reextract` 预览 → 确认',
    })
  }

  return gaps
}

/** decide 第 1 章：缺口清单。 */
export function renderGapList(gaps) {
  const hit = gaps.filter((g) => g.hit)
  const lines = hit.length === 0
    ? ['未发现缺口（G1–G5 均未命中）。']
    : [
        ...table(
          ['编号', '缺口', '严重度', '证据摘要'],
          hit.map((g) => [g.id, g.name, g.severity, g.evidence]),
        ),
      ]
  return { n: 1, title: '缺口清单', lines }
}

/** decide 第 2 章：缺口证据。 */
export function renderGapEvidence(gaps, params) {
  const hit = gaps.filter((g) => g.hit)
  if (hit.length === 0) return { n: 2, title: '缺口证据', lines: ['未命中任何缺口规则，无证据可列。'] }
  const lines = []
  for (const g of hit) {
    lines.push(`### ${g.id} ${g.name}`)
    lines.push('')
    lines.push('判定规则：' + g.rule)
    lines.push('')
    lines.push('实测：' + g.evidence)
    lines.push('')
    lines.push(`命中：${g.hit ? '是' : '否'}（严重度 ${g.severity}）`)
    lines.push('')
  }
  if (params?.gapParams !== undefined) {
    lines.push(`> 阈值参数：${JSON.stringify(params.gapParams)}`)
  }
  return { n: 2, title: '缺口证据', lines }
}

/** decide 第 3 章：方向与动作。 */
export function renderGapActions(gaps, data) {
  const hit = gaps.filter((g) => g.hit)
  if (hit.length === 0) return { n: 3, title: '方向与动作', lines: ['未发现缺口，无需动作。'] }
  const lines = []
  for (const g of hit) {
    lines.push(`### ${g.id} ${g.name}`)
    lines.push('')
    lines.push(`**方向**：${directionOf(g.id, data)}`)
    lines.push('')
    lines.push(`**动作**：${g.action}`)
    lines.push('')

    if (g.id === 'G1') {
      const fixable = data.papers
        .filter((p) => p.depth === 'abstract' || p.hasText !== true)
        .sort((a, b) => b.hitCount - a.hitCount || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 10)
      lines.push('可补清单：')
      lines.push('')
      if (fixable.length === 0) {
        lines.push('（无可补论文）')
      } else {
        lines.push(
          ...table(
            ['标题', '年份', '算法数', '深度', '登记日'],
            fixable.map((p) => [
              p.title,
              fmtYear(p.year),
              p.hitCount,
              p.depth === 'abstract' ? '摘要' : '全文',
              typeof p.readAt === 'number' ? fmtDateTime(p.readAt).slice(0, 10) : '—',
            ]),
            [2],
          ),
        )
      }
      lines.push('')
    }

    if (g.id === 'G2') {
      const thin = data.fields.filter((f) => f.count === 2).map((f) => f.field)
      lines.push('现有起点：')
      lines.push('')
      const starts = []
      for (const field of thin) {
        const list = data.papers
          .filter((p) => (p.fields ?? []).includes(field))
          .sort((a, b) => b.hitCount - a.hitCount)
          .slice(0, 3)
        for (const p of list) starts.push([field, p.title, fmtYear(p.year)])
      }
      if (starts.length === 0) lines.push('（该领域暂无可用起点）')
      else lines.push(...table(['领域', '论文', '年份'], starts, [2]))
      lines.push('')
    }

    if (g.id === 'G5') {
      lines.push('重算前建议先 `radar_reextract` 预览（默认 dryRun），确认 diff 后再执行。')
      lines.push('')
    }
  }
  return { n: 3, title: '方向与动作', lines }
}

function directionOf(id, data) {
  if (id === 'G1') return '先把摘要级 / 无正文的论文补成全文，再谈结论。'
  if (id === 'G2') return `补充「${data.fields.filter((f) => f.count === 2).map((f) => f.field).join('、') || '过薄领域'}」的论文。`
  if (id === 'G3') return '补占比过低的类型（基础模型 / 数学优化），避免画像偏科。'
  if (id === 'G4') return '读近两年的新工作，避免时间断面停在旧年份。'
  return '把旧口径提及重算到当前词典版本。'
}

/** decide 第 5 章：未评估项。 */
export function renderNotEvaluated(data) {
  const rows = []
  const single = data.fields.filter((f) => f.count === 1).map((f) => f.field)
  for (const field of single) {
    rows.push(['领域：' + field, '数据不足，不评估该领域', '1 篇'])
  }
  if (data.counts.papers < 20) {
    rows.push(['类型失衡（G3）', '库太小，类型占比不作结论', `库 ${fmtCount(data.counts.papers)} 篇 < 20`])
  }
  if (data.timeline.undated > 0) {
    rows.push(['无年份论文', '无年份，不进时间维度', `${fmtCount(data.timeline.undated)} 篇`])
  }
  const lines = rows.length === 0 ? ['无未评估项。'] : table(['项目', '原因', '数据'], rows, [2])
  return { n: 5, title: '未评估项', lines }
}

/* ------------------------------------------------------------------ *
 * insight（领域洞察，FR-13.14 / FR-13.15 / RI-1..RI-9）
 * ------------------------------------------------------------------ */

/** 两条必须写进正文的固定声明（RI-4 / RI-9）：字符串只在这里定义一次。 */
export const STATEMENT_COOCCURRENCE = '共现只说明两个算法在同一篇论文中出现过，不说明它们如何结合。'
export const STATEMENT_LIBRARY_SCOPE = '库内热度只反映已登记论文，不等于领域全局现状。'

/** 第 1 节 领域画像。 */
export function renderInsightProfile(data) {
  const c = data.counts
  const span = data.timeline.firstYear === null ? '—' : `${data.timeline.firstYear}–${data.timeline.lastYear}`
  const rows = [
    ['领域', data.field ?? '—'],
    ['论文数', `${fmtCount(c.papers)} 篇`],
    ['占全库比例', `${fmtPct(c.papers, data.library.papers)}（分母=${fmtCount(data.library.papers)}）`],
    ['时间跨度', span],
    ['摘要级占比', `${fmtCount(c.abstract)}/${fmtCount(c.papers)}（${fmtPct(c.abstract, c.papers)}）`],
    ['算法种数', fmtCount(c.algorithms)],
    // D-1：来源构成（与 review 第 2 章同一写法）
    ['来源构成', fmtSourceComposition(data.sourceCounts)],
  ]
  return {
    n: 1,
    title: '领域画像',
    lines: [...table(['指标', '值'], rows), '', `> ${STATEMENT_LIBRARY_SCOPE}`],
  }
}

/** 分层模式下的一张热度表（各自分母，D-5）。 */
function renderHeatTable(algorithms, denominator) {
  const top = algorithms.slice(0, 10)
  if (top.length === 0) return ['（该层没有算法记录）']
  const rows = top.map((a, i) => [
    i + 1,
    a.family ? `${a.name}（${a.type} · ${a.family}）` : `${a.name}（${a.type}）`,
    a.papers,
    a.mentions,
    fmtPct(a.papers, denominator),
    fmtYear(a.firstYear),
  ])
  return table(['#', '算法', '论文数', '提及数', '领域内覆盖率', '首见年'], rows, [0, 2, 3, 4, 5])
}

/** 第 2 节 算法热度 Top 10（领域内）。 */
export function renderInsightHeat(data) {
  // FR-16.3 / D-5：venueScope=allowlist 时拆两张表，各用本层篇数作分母
  if (data.venueScope === 'allowlist' && data.venueLayers !== null) {
    const layers = data.venueLayers
    const lines = []
    lines.push('### 白名单内 Top10')
    lines.push('')
    lines.push(...renderHeatTable(layers.in.algorithms, layers.in.papers))
    lines.push('')
    lines.push(`> 分母 = 白名单内 ${fmtCount(layers.in.papers)} 篇。`)
    lines.push('')
    lines.push('### 白名单外 Top10')
    lines.push('')
    lines.push(...renderHeatTable(layers.out.algorithms, layers.out.papers))
    lines.push('')
    lines.push(`> 分母 = 白名单外 ${fmtCount(layers.out.papers)} 篇。`)
    if (layers.out.missingVenue > 0) {
      lines.push(`> 其中 venue 未标注 ${fmtCount(layers.out.missingVenue)} 篇。`)
    }
    lines.push('')
    lines.push('> 白名单只表示检索范围，不表示论文质量。')
    return { n: 2, title: '算法热度 Top 10', lines }
  }

  const top = data.algorithms.slice(0, 10)
  const lines = []
  if (top.length === 0) {
    lines.push('本次领域内没有算法记录。')
  } else {
    const rows = top.map((a, i) => [
      i + 1,
      a.family ? `${a.name}（${a.type} · ${a.family}）` : `${a.name}（${a.type}）`,
      a.papers,
      a.mentions,
      fmtPct(a.papers, data.counts.papers),
      fmtYear(a.firstYear),
    ])
    lines.push(...table(['#', '算法', '论文数', '提及数', '领域内覆盖率', '首见年'], rows, [0, 2, 3, 4, 5]))
    lines.push('')
    lines.push(
      `> 分母 = 该领域 ${fmtCount(data.counts.papers)} 篇；全库分母为 ${fmtCount(data.library.papers)} 篇，两者不可混比。`,
    )
    const libraryTop = data.libraryTop
    if (libraryTop !== null) {
      if (libraryTop.id !== top[0].id) {
        lines.push(`> 该领域 Top1 是 ${top[0].name}，全库 Top1 是 ${libraryTop.name}（顺序不同，勿混用）。`)
      } else {
        lines.push(`> 该领域 Top1 与全库一致（${top[0].name}）。`)
      }
    }
  }
  return { n: 2, title: '算法热度 Top 10', lines }
}

/** 第 3 节 算法组合 Top 10。 */
export function renderInsightPairs(data) {
  const pairs = data.pairs ?? []
  const minPapers = data.minPairs ?? 3
  const lines = []
  if (pairs.length === 0) {
    lines.push(`本次领域内没有同现 ≥ ${minPapers} 篇的算法组合。`)
  } else {
    const rows = pairs.slice(0, 10).map((p, i) => [
      i + 1,
      `${p.a.name} + ${p.b.name}`,
      p.papers,
      p.lift.toFixed(2),
      fmtPct(p.papers, p.rateDenominator),
    ])
    lines.push(...table(['#', '组合', '同现篇数', 'lift', '同现率'], rows, [0, 2, 3, 4]))
    lines.push('')
    lines.push(`> 同现率 = 同现篇数 ÷ min(两算法各自篇数)；最小同现 ${minPapers} 篇。`)
    lines.push('> lift > 1 表示比随机更常同篇出现；不等价于"搭配使用"。')
    lines.push('> 同现率高但篇数少 → 可能是惯例搭配（如带基线对比）；篇数与 lift 都高 → 更可能是真实组合范式。')
  }
  lines.push(`> ${STATEMENT_COOCCURRENCE}`)
  return { n: 3, title: '算法组合 Top 10', lines }
}

/** 第 4 节 组合证据（定位，不下结论）。 */
export function renderInsightEvidence(data) {
  const evidence = data.evidence ?? []
  const lines = []
  if (evidence.length === 0) {
    lines.push('（本次没有可列举的组合证据。）')
  } else {
    for (const item of evidence) {
      lines.push(
        `### ${item.aName} + ${item.bName}（${item.papers} 篇 / lift ${item.lift.toFixed(2)} / 同现率 ${fmtPct(item.papers, item.rateDenominator)}）`,
      )
      lines.push('')
      lines.push(`同现论文（${item.items.length} 篇）：`)
      lines.push('')
      for (const paper of item.items) {
        const aPart = paper.snippets.a === null ? '片段 —' : `片段：「${paper.snippets.a}」`
        const bPart = paper.snippets.b === null ? '片段 —' : `片段：「${paper.snippets.b}」`
        lines.push(`- 〈${paper.title}〉（${fmtYear(paper.year)}）· ${item.aName} ${aPart} · ${item.bName} ${bPart}`)
      }
      lines.push('')
      lines.push('> 两条片段不保证相邻，仅用于定位；是否串联请读原文。')
      lines.push(`> ${STATEMENT_COOCCURRENCE}`)
      lines.push('')
    }
  }
  if (evidence.length === 0) lines.push(`> ${STATEMENT_COOCCURRENCE}`)
  return { n: 4, title: '组合证据', lines }
}

/** 第 5 节 口径与局限（复用 review 第 9 章同源表 + 三条固定项）。 */
export function renderInsightLimitations(data) {
  const c = data.counts
  const rows = [
    ...limitationRows(data),
    [
      '本领域样本量',
      c.papers < 20 ? `本领域 ${fmtCount(c.papers)} 篇 < 20，排行不具统计意义` : `本领域 ${fmtCount(c.papers)} 篇，样本量可用`,
    ],
    ['库内偏差', STATEMENT_LIBRARY_SCOPE],
    ['共现语义', '共现 ≠ 结合；共现表没有质量信号，不能据此判断哪个算法更好。'],
  ]
  if (data.venueScope === 'allowlist') {
    rows.push(['组合口径', '第 3 节组合基于领域全集，未按白名单过滤（同现样本会被切得太碎）。'])
  }
  return { n: 5, title: '口径与局限', lines: table(['项目', '说明'], rows) }
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

/** P-10 占位块（插件不调模型）。 */
export function narrativeBlock(sectionNumber) {
  return [
    `<!-- radar:insight section=${sectionNumber} -->`,
    '> _（此处待补写解读）_',
  ]
}

/**
 * 渲染整份报告。
 * @param {object} data collectReportData 产出的快照
 * @returns {{ content: string, sections: {n: number, title: string}[] }}
 */
export function renderReport(data) {
  const narrative = data.narrative === 1
  const papers = data.counts.papers
  const notes = []
  const sections = []

  if (data.mode === 'insight') {
    // RI-6：领域 < 5 篇只出画像 + 局限
    if (papers < 5) {
      notes.push('> 本领域仅 ' + papers + ' 篇（< 5）：只出领域画像与口径局限，不出排行与组合。')
      sections.push(renderInsightProfile(data))
      sections.push(renderInsightLimitations(data))
    } else {
      sections.push(renderInsightProfile(data))
      sections.push(renderInsightHeat(data))
      sections.push(renderInsightPairs(data))
      sections.push(renderInsightEvidence(data))
      sections.push(renderInsightLimitations(data))
    }
  } else if (data.mode === 'decide') {
    // §5 空态：0 篇只出口径附录 + 未评估项（不出缺口结论）
    if (papers === 0) {
      notes.push('> 库为空：只出口径附录与未评估项，不出缺口结论。')
      sections.push({
        n: 4,
        title: '口径附录',
        lines: [...renderLimitations(data).lines, '', '> 来源渠道与阅读状态不参与缺口判定（G1–G5 只看数量与结构）。'],
      })
      sections.push(renderNotEvaluated(data))
    } else {
      const gaps = computeGaps(data, { gapParams: data.gapParams })
      const withN = (section, n) => ({ ...section, n })
      sections.push(withN(renderGapList(gaps), 1))
      sections.push(withN(renderGapEvidence(gaps, { gapParams: data.gapParams }), 2))
      sections.push(withN(renderGapActions(gaps, data), 3))
      sections.push({
        n: 4,
        title: '口径附录',
        lines: [...renderLimitations(data).lines, '', '> 来源渠道与阅读状态不参与缺口判定（G1–G5 只看数量与结构）。'],
      })
      sections.push(renderNotEvaluated(data))
    }
  } else if (papers < 5) {
    // FR-13.7 / §5：< 5 篇只出数据画像 + 局限 + 附录，不出结论章
    notes.push(`> 数据不足（${papers} 篇 < 5）：只出数据画像、可信度与附录，不出结论章。`)
    sections.push(renderProfile(data))
    sections.push({ n: 9, title: '可信度与局限', lines: renderLimitations(data).lines })
  } else {
    sections.push(renderSummary(data))
    sections.push(renderProfile(data))
    sections.push(renderRanking(data))
    sections.push(renderTypeDistribution(data))
    sections.push(renderTimeline(data))
    sections.push(renderFieldDistribution(data))
    sections.push(renderRepresentativePapers(data))
    sections.push(renderRecent(data))
    sections.push({ n: 9, title: '可信度与局限', lines: renderLimitations(data).lines })
  }

  // 附录：先算前面用了多少行，再把剩余额度给附录；超出 400 行就收预算重算（§0.4）
  // 只有 review 有附录章；decide 与 insight 都没有
  if (data.mode === 'review') {
    const used =
      renderHeader(data).length +
      notes.length +
      sections.reduce((sum, s) => sum + 3 + s.lines.length + (narrative ? 3 : 0), 0)
    let budget = Math.max(2, 400 - used - 12)
    let appendix = renderAppendix(data, { maxRows: budget })
    for (let i = 0; i < 50; i += 1) {
      const total = used + 3 + appendix.lines.length
      if (total <= 400) break
      // 目标取 399 而不是 400：留 1 行余量，避免「减掉的正是新增的截断说明行」来回震荡
      budget -= Math.max(1, total - 399)
      if (budget < 2) {
        budget = 2
        appendix = renderAppendix(data, { maxRows: budget })
        break
      }
      appendix = renderAppendix(data, { maxRows: budget })
    }
    sections.push(appendix)
  }

  const out = [...renderHeader(data), ...notes]
  for (const section of sections) {
    out.push('')
    out.push(`## ${section.n}. ${section.title}`)
    out.push('')
    out.push(...section.lines)
    if (narrative) {
      out.push('')
      out.push(...narrativeBlock(section.n))
    }
  }
  out.push('')

  return {
    content: out.join('\n'),
    sections: sections.map((s) => ({ n: s.n, title: s.title })),
  }
}
