/**
 * 纯函数抽取引擎（§8 R1–R8）。
 *
 * 约束（G-1…G-6）：
 *  - 不读时钟、不读环境、不发网络、不碰数据库、不读配置；
 *  - 同一 `(text, dict, dictVersion)` 任意两次调用输出逐字节一致；
 *  - 处理顺序固定 R1 → R8；
 *  - 长度与偏移按 code point 计（匹配用的正则下标是 UTF-16，这是 JS 的既成事实，
 *    所以内部同时维护两套下标：`u16` 供正则比较，`cp` 供规则阈值判断）。
 *
 * 已知偏差：证据片段的前后窗口按 UTF-16 取（−60 / +140），最终长度按 code point 截到 200。
 * 对 BMP 字符（含绝大多数中日韩）两者等价；仅星平面字符会有几个字符的差。
 *
 * @module paper-algo-radar/extract
 */

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 按 code point 计长度。 */
export function codePointLength(text) {
  let n = 0
  for (const _ of String(text ?? '')) n += 1
  return n
}

/** 按 code point 取前 n 个，不切断代理对。 */
export function sliceCodePoints(text, n) {
  const out = []
  for (const ch of String(text ?? '')) {
    if (out.length >= n) break
    out.push(ch)
  }
  return out.join('')
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/* ------------------------------------------------------------------ *
 * R1 文本规范化
 * ------------------------------------------------------------------ */

export function normalizeText(raw) {
  let text = String(raw ?? '')
  // 1. NFKC → NFC
  text = text.normalize('NFKC').normalize('NFC')
  // 2. 换行统一
  text = text.replace(/\r\n?/g, '\n')
  // 3. 零宽 / 双向控制字符
  text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
  // 4. 连续 ≥3 换行折叠为 2
  text = text.replace(/\n{3,}/g, '\n\n')
  return text
}

/* ------------------------------------------------------------------ *
 * 行扫描：同时维护 UTF-16 下标与 code point 下标
 * ------------------------------------------------------------------ */

function scanLines(text) {
  const lines = []
  let u16 = 0
  let cp = 0
  for (const line of text.split('\n')) {
    const lineCp = codePointLength(line)
    lines.push({
      raw: line,
      trimmed: line.trim(),
      startU16: u16,
      startCp: cp,
      lengthCp: lineCp,
    })
    u16 += line.length + 1
    cp += lineCp + 1
  }
  return { lines, totalCp: Math.max(0, cp - 1) }
}

/* ------------------------------------------------------------------ *
 * R5 章节表（R2 也要用，所以先定义）
 * ------------------------------------------------------------------ */

const SECTION_TABLE = [
  ['abstract', ['abstract', '摘要', '内容提要']],
  ['intro', ['introduction', '引言', '前言']],
  ['related', ['related work', 'related works', 'background', '相关工作', '文献综述', '研究现状']],
  [
    'method',
    ['method', 'methods', 'methodology', 'approach', 'proposed method', '方法', '模型', '架构', '算法设计'],
  ],
  [
    'experiment',
    ['experiment', 'experiments', 'evaluation', 'results', '实验', '结果', '实验设置', '结果与分析'],
  ],
  ['discussion', ['discussion', '讨论']],
  ['conclusion', ['conclusion', 'conclusions', '结论', '总结', '结语']],
]

const SECTION_KEYWORDS = SECTION_TABLE.map(([key, words]) => [key, words.map((w) => w.toLowerCase())])

/** 去掉 markdown 前缀与编号，返回标题正文（已小写化）。 */
function headingBody(trimmed) {
  return trimmed
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d+(?:\.\d+)*[.、]?\s*/, '')
    .replace(/[\s:：.。]+$/, '')
    .trim()
    .toLowerCase()
}

/** 命中章节关键词则返回章节键，否则 null。 */
export function headingKeyOf(trimmed) {
  if (trimmed === '' || codePointLength(trimmed) > 80) return null
  // 不以句末标点结尾
  if (/[。．.!?！？；;、,，]$/.test(trimmed)) return null
  // 含 ≥1 中文字符，或全行 ASCII 字母 ≥3
  const hasCjk = CJK.test(trimmed)
  const asciiLetters = (trimmed.match(/[A-Za-z]/g) ?? []).length
  if (!hasCjk && asciiLetters < 3) return null

  const body = headingBody(trimmed)
  if (body === '') return null
  for (const [key, words] of SECTION_KEYWORDS) {
    for (const word of words) {
      if (body === word) return key
      // 允许「关键词 + 分隔符 + 补充说明」，如 "3 Method: Overview"
      if (body.startsWith(word) && /^[\s:：\-—/]/.test(body.slice(word.length))) return key
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * R2 页码与页眉行剔除
 * ------------------------------------------------------------------ */

const PAGE_LINE = /^\s*(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?\s*$/

export function stripArtifacts(lines) {
  const freq = new Map()
  for (const line of lines) {
    const t = line.trimmed
    if (t === '') continue
    if (codePointLength(t) > 60) continue
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }

  const kept = []
  let removed = 0
  for (const line of lines) {
    const t = line.trimmed
    // R2.1 页码行
    if (PAGE_LINE.test(line.raw)) {
      removed += 1
      continue
    }
    // R2.2 全文出现 ≥3 次、长度 ≤60 的完全相同的行（命中章节关键词的保留）
    if (t !== '' && codePointLength(t) <= 60 && (freq.get(t) ?? 0) >= 3 && headingKeyOf(t) === null) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  return { lines: kept, removedLines: removed }
}

/* ------------------------------------------------------------------ *
 * R3 参考文献截断
 * ------------------------------------------------------------------ */

const REF_L1 =
  /^(?:\d+[.、]\s*)?(references|bibliography|literature cited|works cited|参考文献|引用文献|參考文獻)\s*[:：.]?$/i
const REF_L2_LINE = /^\s*(?:\[\d{1,3}\]|\d{1,3}[.、])\s+\S/

export function cutReferences(lines, totalCp) {
  const threshold = Math.max(Math.floor(totalCp * 0.25), 3000)
  let refHintEarly = false

  // L1：标题行
  for (const line of lines) {
    if (!REF_L1.test(line.trimmed)) continue
    if (codePointLength(line.trimmed) > 60) continue
    if (line.startCp >= threshold) {
      const kept = lines.filter((l) => l.startCp < line.startCp)
      const keptCp = kept.reduce((sum, l) => sum + l.lengthCp + 1, 0)
      return {
        lines: kept,
        refCut: { method: 'L1', at: line.startCp, kept: Math.max(0, keptCp - 1) },
        refHintEarly: false,
      }
    }
    // 候选标题出现在 25% 之前：不截断，只记提示
    refHintEarly = true
  }

  // L2：编号段落（无标题时）
  const fromCp = Math.floor(totalCp * 0.3)
  let runStart = -1
  let runCount = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startCp < fromCp) continue
    if (REF_L2_LINE.test(line.raw) && codePointLength(line.trimmed) <= 200) {
      if (runStart < 0) runStart = i
      runCount += 1
      if (runCount >= 8) {
        const at = lines[runStart].startCp
        const kept = lines.slice(0, runStart)
        const keptCp = kept.reduce((sum, l) => sum + l.lengthCp + 1, 0)
        return {
          lines: kept,
          refCut: { method: 'L2', at, kept: Math.max(0, keptCp - 1) },
          refHintEarly,
        }
      }
    } else {
      runStart = -1
      runCount = 0
    }
  }

  return { lines, refCut: { method: null, at: null, kept: totalCp }, refHintEarly }
}

/* ------------------------------------------------------------------ *
 * R6 别名匹配
 * ------------------------------------------------------------------ */

/** 2–6 位全大写（含数字但不含连字符）⇒ 条目按大小写敏感匹配（R6.5，条目级）。 */
export function entryCaseSensitive(aliases) {
  return aliases.some((alias) => /^[A-Z0-9]{2,6}$/.test(alias) && /[A-Z]/.test(alias))
}

const PLURAL_EXCEPTIONS = new Map()

/** R6.6 单复数：仅 ASCII、非大小写敏感、长度 ≥3、不含数字。不支持反向。 */
export function pluralOf(alias) {
  if (!/^[A-Za-z][A-Za-z\- ]*$/.test(alias)) return null
  if (alias.length < 3) return null
  if (/\d/.test(alias)) return null
  if (PLURAL_EXCEPTIONS.has(alias)) return PLURAL_EXCEPTIONS.get(alias)
  // 多词别名只把最后一个词变复数
  const parts = alias.split(' ')
  const last = parts[parts.length - 1]
  let plural
  if (/[^aeiou]y$/i.test(last)) plural = last.slice(0, -1) + 'ies'
  else if (/(s|x|z|ch|sh)$/i.test(last)) plural = last + 'es'
  else plural = last + 's'
  parts[parts.length - 1] = plural
  return parts.join(' ')
}

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 构造匹配表。`lexicon` 元素形如 { id, name, type, aliases }。
 * 返回每个条目的 `{ id, name, type, caseSensitive, patterns }`。
 */
export function buildMatchers(lexicon) {
  return lexicon.map((entry) => {
    const caseSensitive = entryCaseSensitive(entry.aliases)
    const flags = caseSensitive ? 'g' : 'gi'
    const seen = new Set()
    const variants = []
    for (const alias of entry.aliases) {
      if (typeof alias !== 'string' || alias === '') continue
      const forms = [alias]
      if (!caseSensitive) {
        const plural = pluralOf(alias)
        if (plural !== null && plural !== alias) forms.push(plural)
      }
      for (const form of forms) {
        const key = caseSensitive ? form : form.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        variants.push(form)
      }
    }
    const patterns = variants.map((form) => {
      // R6.7 中文别名不加任何边界断言
      const boundary = CJK.test(form) ? '()' : '(?<![A-Za-z0-9_])'
      const trailing = CJK.test(form) ? '' : '(?![A-Za-z0-9_])'
      const source = boundary === '()' ? escapeRegExp(form) : `${boundary}${escapeRegExp(form)}${trailing}`
      return { source: form, re: new RegExp(source, flags) }
    })
    return { id: entry.id, name: entry.name, type: entry.type ?? 'OTHER', caseSensitive, patterns }
  })
}

/* ------------------------------------------------------------------ *
 * R7 证据片段
 * ------------------------------------------------------------------ */

function snippetAt(body, startU16, endU16) {
  const winStart = Math.max(0, startU16 - 240)
  const winEnd = Math.min(body.length, endU16 + 480)
  const region = body.slice(winStart, winEnd)
  const cps = [...region]
  // 命中点在 region 里的 code point 位置
  const lead = [...body.slice(winStart, startU16)].length
  const matchCp = [...body.slice(startU16, endU16)].length
  const from = Math.max(0, lead - 60)
  const to = Math.min(cps.length, lead + matchCp + 140)
  let text = cps.slice(from, to).join('').replace(/\s+/g, ' ').trim()
  if (codePointLength(text) > 200) text = sliceCodePoints(text, 200)
  return text
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

export const EMPTY_SECTIONS = () => ({
  abstract: 0,
  intro: 0,
  related: 0,
  method: 0,
  experiment: 0,
  discussion: 0,
  conclusion: 0,
  other: 0,
})

/**
 * @param {string} raw 原始正文
 * @param {Array} matchers buildMatchers() 的结果
 * @param {{ dictVersion?: string, depth?: 'fulltext'|'abstract' }} options
 */
export function extract(raw, matchers, options = {}) {
  // R1
  const normalized = normalizeText(raw)

  // R2
  const scanned = scanLines(normalized)
  const artifactFree = stripArtifacts(scanned.lines)
  const afterR2Text = artifactFree.lines.map((l) => l.raw).join('\n')
  const afterR2Cp = codePointLength(afterR2Text)

  // R3
  const cut = cutReferences(artifactFree.lines, afterR2Cp)
  const afterR3Text = cut.lines.map((l) => l.raw).join('\n')

  // R4
  const statText = sliceCodePoints(afterR3Text, 400000)
  const chars = codePointLength(statText)

  // R5 章节边界（在统计文本上重新扫描，保证下标一致）
  const body = statText
  const headings = []
  {
    let u16 = 0
    for (const line of body.split('\n')) {
      const key = headingKeyOf(line.trim())
      if (key !== null) headings.push({ at: u16, key })
      u16 += line.length + 1
    }
    headings.sort((a, b) => a.at - b.at)
  }

  // R6 匹配
  const raw_hits = []
  for (const entry of matchers) {
    for (const pattern of entry.patterns) {
      pattern.re.lastIndex = 0
      let match
      while ((match = pattern.re.exec(body)) !== null) {
        if (match[0].length === 0) {
          pattern.re.lastIndex += 1
          continue
        }
        raw_hits.push({
          id: entry.id,
          name: entry.name,
          type: entry.type,
          start: match.index,
          end: match.index + match[0].length,
          alias: pattern.source,
        })
      }
    }
  }

  // R6.2 排序：start 升序 → 长度降序 → algorithmId 升序 → alias 升序（禁插入序）
  raw_hits.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0)
  )

  // R6.3 左端点优先 + 同起点最长 + 消费
  const accepted = []
  let lastEnd = -1
  for (const hit of raw_hits) {
    if (hit.start >= lastEnd) {
      accepted.push(hit)
      lastEnd = hit.end
    }
  }

  // 归属章节
  let cursor = 0
  let currentSection = 'other'
  const byId = new Map()
  for (const hit of accepted) {
    while (cursor < headings.length && headings[cursor].at <= hit.start) {
      currentSection = headings[cursor].key
      cursor += 1
    }
    let record = byId.get(hit.id)
    if (record === undefined) {
      record = {
        id: hit.id,
        name: hit.name,
        type: hit.type,
        count: 0,
        sections: EMPTY_SECTIONS(),
        snippets: [],
        positions: [],
      }
      byId.set(hit.id, record)
    }
    record.count += 1
    record.sections[currentSection] = (record.sections[currentSection] ?? 0) + 1
    record.positions.push({ start: hit.start, end: hit.end, section: currentSection })
  }

  // R7 选片段：优先跨章节，同章节起点相隔 ≥500；最多 3 条
  for (const record of byId.values()) {
    const chosen = []
    const usedSections = new Set()
    for (const pos of record.positions) {
      if (chosen.length >= 3) break
      if (usedSections.has(pos.section)) continue
      chosen.push(pos)
      usedSections.add(pos.section)
    }
    if (chosen.length < 3) {
      for (const pos of record.positions) {
        if (chosen.length >= 3) break
        if (chosen.includes(pos)) continue
        if (chosen.some((p) => Math.abs(p.start - pos.start) < 500)) continue
        chosen.push(pos)
      }
    }
    chosen.sort((a, b) => a.start - b.start)
    record.snippets = chosen.slice(0, 3).map((pos) => snippetAt(body, pos.start, pos.end))
    delete record.positions
  }

  // R8.1 告警
  const warnings = []
  const depth = options.depth === 'abstract' ? 'abstract' : 'fulltext'
  if (depth === 'fulltext' && chars > 0 && chars < 3000) warnings.push('suspect:short')
  if (depth === 'abstract' && chars < 120) warnings.push('suspect:short')
  if (/pdf/i.test(String(options.source ?? '')) && chars > 0 && chars < 1200) warnings.push('suspect:extract')

  const hits = [...byId.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )

  return {
    // R1 之后、R3/R4 之前的文本 —— 正文留存口径（P-5）
    retainedText: normalized,
    // 参与统计的文本（R4 之后）
    statsText: body,
    chars,
    hits,
    refCut: cut.refCut,
    refHintEarly: cut.refHintEarly,
    removedLines: artifactFree.removedLines,
    dictVersion: options.dictVersion ?? '',
    depth,
    warnings,
  }
}
