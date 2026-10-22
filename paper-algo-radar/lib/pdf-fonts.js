/**
 * PDF 字体感知的文本提取（零依赖）。
 *
 * 解决的问题：CID/Type0 字体（Identity-H，中文期刊 PDF 最常见）的内容流里放的是
 * **字形编号**，不是 Unicode 字节。直接把字节当 latin1 读，得到的是乱码。
 * 正确做法是顺着 `/ToUnicode` 流里的 CMap（`beginbfchar` / `beginbfrange`）
 * 把字形号映射回 Unicode；没有 ToUnicode 时，再看预定义 CMap（UCS2 / GBK / Big5）。
 *
 * 能力边界（如实报告，不假装成功）：
 *  - 支持：Type0 + Identity-H + ToUnicode；预定义 CMap `/UniGB-UCS2-H`、`/GBK-EUC-H`、
 *    `/B5pc-H` 等；简单字体（Type1/TrueType）按 latin1 处理
 *  - 不支持：没有 ToUnicode 的 Identity-H（只有字形号）、对象流（ObjStm）里的页面/字体、
 *    加密 PDF、扫描件
 *
 * 这里的解析是**够用即止**的对象扫描，不是完整 PDF 解析器：按 `N 0 obj … endobj`
 * 顺序索引对象，流用 `stream … endstream` 切；页面按 `/Type /Page` 收集。
 *
 * @module paper-algo-radar/pdf-fonts
 */
import { inflateSync, inflateRawSync } from 'node:zlib'

import { analyzeText } from './textquality.js'

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0'])
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

const isWs = (ch) => WS.has(ch)
const isDelim = (ch) => DELIM.has(ch)

/** 解 PDF 字符串字面量的转义，返回逐字节的 latin1 字符串。 */
export function unescapeBytes(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    i += 1
    if (next === undefined) break
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === '\\') out += '\\'
    else if (next === '(') out += '('
    else if (next === ')') out += ')'
    else if (next === '\n') out += ''
    else if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) {
        octal += raw[i + 1]
        i += 1
      }
      out += String.fromCharCode(parseInt(octal, 8) & 0xff)
    } else out += next
  }
  return out
}

/** 索引所有间接对象：对象号 → { dict, stream }。 */
export function indexObjects(buffer) {
  const text = buffer.toString('latin1')
  const objects = new Map()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let match = re.exec(text)
  while (match !== null) {
    const num = Number(match[1])
    const bodyStart = re.lastIndex
    const endObj = text.indexOf('endobj', bodyStart)
    const limit = endObj < 0 ? text.length : endObj
    const body = text.slice(bodyStart, limit)
    let dict = body
    let stream = null
    const streamAt = body.search(/stream(\r\n|\r|\n)/)
    if (streamAt >= 0) {
      const eol = /stream(\r\n|\r|\n)/.exec(body.slice(streamAt, streamAt + 8))
      dict = body.slice(0, streamAt)
      const dataStart = bodyStart + streamAt + 'stream'.length + (eol ? eol[1].length : 0)
      const dataEnd = text.indexOf('endstream', dataStart)
      if (dataEnd > dataStart) stream = buffer.subarray(dataStart, dataEnd)
    }
    objects.set(num, { num, dict, stream })
    re.lastIndex = Math.max(re.lastIndex, limit)
    match = re.exec(text)
  }
  return objects
}

/** 解一个流对象（FlateDecode / 未压缩）成 latin1 字符串；失败返回 ''。 */
export function streamText(object) {
  if (!object || !object.stream) return ''
  const dict = String(object.dict)
  if (/\/FlateDecode|\/Fl\b/.test(dict)) {
    try {
      return inflateSync(object.stream).toString('latin1')
    } catch {
      try {
        return inflateRawSync(object.stream).toString('latin1')
      } catch {
        return ''
      }
    }
  }
  return object.stream.toString('latin1')
}

/** UTF-16BE 字节 → 字符串。 */
function utf16be(hex) {
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return out
}

/** 从源码递增目标码（多码元时只递增最后一个码元）。 */
function incrementUtf16(text, delta) {
  if (text === '') return ''
  const head = text.slice(0, -1)
  const last = text.charCodeAt(text.length - 1) + delta
  return head + String.fromCharCode(last & 0xffff)
}

/**
 * 解析 ToUnicode CMap。
 * @returns {{ codeBytes: number, map: Map<number, string> }}
 */
export function parseToUnicode(text) {
  const map = new Map()
  let codeBytes = 2
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text)
  if (space) {
    const first = /<([0-9a-fA-F]+)>/.exec(space[1])
    if (first) codeBytes = Math.max(1, first[1].length / 2)
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), utf16be(pair[2]))
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g
    for (const item of body.matchAll(re)) {
      const lo = parseInt(item[1], 16)
      const hi = parseInt(item[2], 16)
      if (item[3] !== undefined) {
        const base = utf16be(item[3])
        for (let code = lo; code <= hi; code += 1) map.set(code, incrementUtf16(base, code - lo))
      } else if (item[4] !== undefined) {
        const targets = [...item[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => utf16be(m[1]))
        targets.forEach((target, index) => {
          if (lo + index <= hi) map.set(lo + index, target)
        })
      }
    }
  }
  return { codeBytes, map }
}

/** 一段字节按 CMap 解码。 */
export function decodeWithCMap(bytes, cmap) {
  const { codeBytes, map } = cmap
  let out = ''
  for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
    const code = codeBytes === 1 ? bytes[i] : (bytes[i] << 8) | bytes[i + 1]
    out += map.get(code) ?? ''
  }
  return out
}

const textDecoders = new Map()
function decoderForEncoding(name) {
  const key = String(name)
  if (textDecoders.has(key)) return textDecoders.get(key)
  let decoder = null
  try {
    if (/UCS2|UTF16/i.test(key)) {
      decoder = (bytes) => {
        let out = ''
        for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
        return out
      }
    } else if (/GBK|GB-EUC|GBpc-EUC|GBT-EUC/i.test(key)) {
      const impl = new TextDecoder('gbk')
      decoder = (bytes) => impl.decode(bytes)
    } else if (/B5pc|ETen-B5|B5-H|B5-V/i.test(key)) {
      const impl = new TextDecoder('big5')
      decoder = (bytes) => impl.decode(bytes)
    }
  } catch {
    decoder = null
  }
  textDecoders.set(key, decoder)
  return decoder
}

const latin1 = (bytes) => bytes.toString('latin1')

/** 字体对象 → 解码函数（拿不到映射时返回 null，由调用方按 latin1 兜底）。 */
export function decoderForFont(objects, fontObject) {
  if (!fontObject) return null
  const dict = String(fontObject.dict)
  const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (toUnicode) {
    const cmapText = streamText(objects.get(Number(toUnicode[1])))
    if (cmapText !== '') {
      // CMap 只解析一次；放进闭包里每解一次字符串就重解析会慢两个数量级（实测 178k 次）。
      const cmap = parseToUnicode(cmapText)
      return (bytes) => decodeWithCMap(bytes, cmap)
    }
  }
  const encoding = /\/Encoding\s*\/([A-Za-z0-9#+._-]+)/.exec(dict)
  if (encoding && !/Identity/.test(encoding[1])) return decoderForEncoding(encoding[1])
  return null
}

/** 从一段 dict 文本里取平衡的 `<< … >>` 块。 */
function balancedDict(text) {
  const start = text.indexOf('<<')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2)
    if (pair === '<<') {
      depth += 1
      i += 1
      continue
    }
    if (pair === '>>') {
      depth -= 1
      i += 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 页面的 Resources（含沿 /Parent 继承）。 */
export function resourcesOf(page, objects) {
  let current = page
  for (let depth = 0; depth < 12 && current; depth += 1) {
    const dict = String(current.dict)
    const ref = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(dict)
    if (ref) return objects.get(Number(ref[1])) ?? null
    const at = dict.indexOf('/Resources')
    if (at >= 0) {
      const block = balancedDict(dict.slice(at))
      if (block) return { dict: block }
    }
    const parent = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(dict)
    current = parent ? objects.get(Number(parent[1])) : null
  }
  return null
}

/** 页面的字体表：资源名（F1…）→ 字体对象。 */
export function fontsOf(page, objects) {
  const fonts = new Map()
  const resources = resourcesOf(page, objects)
  if (!resources) return fonts
  const dict = String(resources.dict)
  let fontDict = ''
  const ref = /\/Font\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (ref) fontDict = String(objects.get(Number(ref[1]))?.dict ?? '')
  else {
    const at = dict.indexOf('/Font')
    if (at >= 0) fontDict = balancedDict(dict.slice(at)) ?? ''
  }
  for (const item of fontDict.matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fontObject = objects.get(Number(item[2]))
    if (fontObject) fonts.set(item[1], fontObject)
  }
  return fonts
}

/** 页面内容流的对象号。 */
export function contentRefsOf(page) {
  const dict = String(page.dict)
  const refs = []
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict)
  if (array) {
    for (const item of array[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(item[1]))
    return refs
  }
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (single) refs.push(Number(single[1]))
  return refs
}

/** 把内容流切成 token（字符串按字节保留）。 */
export function tokenizeContent(content) {
  const tokens = []
  const text = String(content)
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (isWs(ch)) {
      i += 1
      continue
    }
    if (ch === '%') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '(') {
      let depth = 1
      let j = i + 1
      let raw = ''
      while (j < n && depth > 0) {
        const c = text[j]
        if (c === '\\') {
          raw += c + (text[j + 1] ?? '')
          j += 2
          continue
        }
        if (c === '(') depth += 1
        if (c === ')') {
          depth -= 1
          if (depth === 0) {
            j += 1
            break
          }
        }
        raw += c
        j += 1
      }
      tokens.push({ type: 'string', value: Buffer.from(unescapeBytes(raw), 'latin1') })
      i = j
      continue
    }
    if (ch === '<' && text[i + 1] === '<') {
      const block = balancedDict(text.slice(i))
      const used = block === null ? n : i + block.length
      tokens.push({ type: 'dict', value: text.slice(i, used) })
      i = used
      continue
    }
    if (ch === '<') {
      const end = text.indexOf('>', i)
      const j = end < 0 ? n : end
      const hex = text.slice(i + 1, j).replace(/[^0-9a-fA-F]/g, '')
      const padded = hex.length % 2 === 0 ? hex : hex + '0'
      tokens.push({ type: 'string', value: Buffer.from(padded, 'hex') })
      i = j + 1
      continue
    }
    if (ch === '[') {
      tokens.push({ type: 'arrayStart' })
      i += 1
      continue
    }
    if (ch === ']') {
      tokens.push({ type: 'arrayEnd' })
      i += 1
      continue
    }
    if (ch === '/') {
      let j = i + 1
      while (j < n && !isWs(text[j]) && !isDelim(text[j])) j += 1
      tokens.push({ type: 'name', value: text.slice(i + 1, j) })
      i = j
      continue
    }
    let j = i
    while (j < n && !isWs(text[j]) && !isDelim(text[j])) j += 1
    if (j === i) {
      i += 1
      continue
    }
    const word = text.slice(i, j)
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ type: 'number', value: Number(word) })
    else tokens.push({ type: 'op', value: word })
    i = j
  }
  return tokens
}

/** 字体解码器缓存：同一份 PDF 里一个字体只解析一次 CMap。 */
function decoderForCached(objects, fontObject, cache) {
  if (!fontObject) return null
  const key = fontObject.num ?? -1
  if (cache.has(key)) return cache.get(key)
  const decoder = decoderForFont(objects, fontObject)
  cache.set(key, decoder)
  return decoder
}

/**
 * token 流 → 文本。
 *
 * 断行按**纵坐标变化**判断：很多中文 PDF（含发票、期刊排版）每个字形单独 `Td`，
 * 若见到 Td 就断行，`遗传算法` 会被拆成四行、匹配器再也认不出来。同一行内的
 * `Td`（ty≈0）只拼接不断行。
 */
export function textFromTokens(tokens, fonts, decoderCache = new Map()) {
  const parts = []
  let pending = ''
  let decode = latin1
  let lineY = null
  const flush = () => {
    if (pending.trim() !== '') parts.push(pending.trim())
    pending = ''
  }
  const moved = (nextY) => {
    if (pending !== '' && lineY !== null && Math.abs(nextY - lineY) > 1) flush()
    lineY = nextY
  }
  let stack = []
  let array = null
  for (const token of tokens) {
    if (token.type === 'arrayStart') {
      array = []
      continue
    }
    if (token.type === 'arrayEnd') {
      stack.push(array ?? [])
      array = null
      continue
    }
    if (array !== null) {
      if (token.type === 'string') array.push({ kind: 'string', bytes: token.value })
      else if (token.type === 'number') array.push({ kind: 'number', value: token.value })
      continue
    }
    if (token.type === 'op') {
      const op = token.value
      const numbers = stack.filter((item) => item.type === 'number').map((item) => item.value)
      if (op === 'Tf') {
        const named = [...stack].reverse().find((item) => item.type === 'name')
        const fontObject = named === undefined ? undefined : fonts.get(named.value)
        decode = decoderForCached(fonts.objects, fontObject, decoderCache) ?? latin1
      } else if (op === 'Tj' || op === "'" || op === '"') {
        const string = [...stack].reverse().find((item) => item.type === 'string')
        if (string !== undefined) pending += decode(string.value)
        if (op !== 'Tj') flush()
      } else if (op === 'TJ') {
        const list = [...stack].reverse().find((item) => Array.isArray(item))
        if (list !== undefined) {
          for (const item of list) if (item.kind === 'string') pending += decode(item.bytes)
        }
      } else if (op === 'Tm' && numbers.length >= 6) {
        moved(numbers[5])
      } else if ((op === 'Td' || op === 'TD') && numbers.length >= 2) {
        moved((lineY ?? 0) + numbers[1])
      } else if (op === 'T*' || op === 'BT') {
        flush()
      } else if (op === 'BI') {
        // 内联图片：跳过二进制数据，避免把图像字节当 token
        stack = []
        continue
      }
      stack = []
      continue
    }
    stack.push(token)
  }
  flush()
  return parts.join('\n')
}

/** 页面或表单的 XObject 子资源（表单里可能还套表单）。 */
function xobjectTexts(container, objects, stats, decoderCache, depth) {
  if (depth > 8) return []
  const out = []
  const resources = resourcesOf(container, objects)
  if (!resources) return out
  const dict = String(resources.dict)
  let xdict = ''
  const ref = /\/XObject\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (ref) xdict = String(objects.get(Number(ref[1]))?.dict ?? '')
  else {
    const at = dict.indexOf('/XObject')
    if (at >= 0) xdict = balancedDict(dict.slice(at)) ?? ''
  }
  for (const item of xdict.matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const object = objects.get(Number(item[2]))
    if (!object) continue
    if (/\/Subtype\s*\/Image/.test(String(object.dict))) continue
    const formFonts = fontsOf(object, objects)
    formFonts.objects = objects
    stats.fontCount = (stats.fontCount ?? 0) + formFonts.size
    for (const fontObject of formFonts.values()) {
      if (/\/Subtype\s*\/Type0/.test(String(fontObject.dict))) stats.cidFonts = (stats.cidFonts ?? 0) + 1
    }
    const content = streamText(object)
    if (content !== '') {
      stats.streams += 1
      const text = textFromTokens(tokenizeContent(content), formFonts, decoderCache)
      if (text !== '') out.push(text)
    }
    out.push(...xobjectTexts(object, objects, stats, decoderCache, depth + 1))
  }
  return out
}

/** 页面对象（按对象号近似文档顺序）。 */
export function pageObjects(objects) {
  return [...objects.values()]
    .filter((object) => /\/Type\s*\/Page\b/.test(String(object.dict)))
    .sort((a, b) => a.num - b.num)
}

/** 把对象流（/ObjStm）里的对象也索引进来；已有同名直接对象不覆盖。 */
export function indexObjectStreams(buffer, objects) {
  let added = 0
  for (const object of [...objects.values()]) {
    const dict = String(object.dict)
    if (!/\/Type\s*\/ObjStm/.test(dict)) continue
    const body = streamText(object)
    if (body === '') continue
    const total = Number((/\/N\s+(\d+)/.exec(dict) ?? [])[1] ?? 0)
    const first = Number((/\/First\s+(\d+)/.exec(dict) ?? [])[1] ?? 0)
    if (total <= 0 || first <= 0) continue
    const header = body.slice(0, first)
    const numbers = []
    const offsets = []
    for (const pair of header.matchAll(/(\d+)\s+(\d+)/g)) {
      if (numbers.length >= total) break
      numbers.push(Number(pair[1]))
      offsets.push(Number(pair[2]))
    }
    for (let index = 0; index < numbers.length; index += 1) {
      const num = numbers[index]
      if (objects.has(num)) continue
      const start = first + offsets[index]
      const end = index + 1 < numbers.length ? first + offsets[index + 1] : body.length
      objects.set(num, { num, dict: body.slice(start, end).trim(), stream: null })
      added += 1
    }
  }
  return added
}

/**
 * 用字体映射提取整份 PDF 的文本。
 * @returns {{ text: string, pageCount: number, fontCount: number, cidFontCount: number, objectCount: number, diagnostics: string[] }}
 */
export function extractTextWithFonts(buffer) {
  const diagnostics = []
  const objects = indexObjects(buffer)
  if (objects.size === 0) return { text: '', pageCount: 0, fontCount: 0, cidFontCount: 0, objectCount: 0, diagnostics: ['没有索引到任何对象'] }
  const fromStreams = indexObjectStreams(buffer, objects)
  if (fromStreams > 0) diagnostics.push(`对象流里补出 ${fromStreams} 个对象`)
  const pages = pageObjects(objects)
  if (pages.length === 0) {
    return { text: '', pageCount: 0, fontCount: 0, cidFontCount: 0, objectCount: objects.size, diagnostics: [...diagnostics, '没有找到页面对象（/Type /Page）'] }
  }

  const pageTexts = []
  const decoderCache = new Map()
  let fontCount = 0
  let cidFontCount = 0
  let decodedStreams = 0
  let droppedPages = 0
  for (const page of pages) {
    const fonts = fontsOf(page, objects)
    fontCount += fonts.size
    for (const fontObject of fonts.values()) {
      if (/\/Subtype\s*\/Type0/.test(String(fontObject.dict))) cidFontCount += 1
    }
    fonts.objects = objects
    const stats = { streams: 0 }
    const chunks = []
    for (const ref of contentRefsOf(page)) {
      const content = streamText(objects.get(ref))
      if (content === '') continue
      decodedStreams += 1
      chunks.push(textFromTokens(tokenizeContent(content), fonts, decoderCache))
    }
    // 很多排版软件把正文放进表单 XObject（页面上只有一个 Do），正文的字体在表单自己的资源里
    const formTexts = xobjectTexts(page, objects, stats, decoderCache, 0)
    fontCount += stats.fontCount ?? 0
    cidFontCount += stats.cidFonts ?? 0
    decodedStreams += stats.streams
    if (formTexts.length > 0) chunks.push(...formTexts)
    const pageText = chunks.join('\n').trim()
    if (pageText === '') continue
    // 混合型 PDF（部分页是自定义编码的简单字体）只保留能读的页，别让噪声页拖垮整份
    if (!analyzeText(pageText).usable) {
      droppedPages += 1
      continue
    }
    pageTexts.push(pageText)
  }
  if (cidFontCount > 0) diagnostics.push(`有 ${cidFontCount} 个 CID/Type0 字体`)
  if (droppedPages > 0) diagnostics.push(`丢弃 ${droppedPages} 个读不出文字的页`)
  return {
    text: pageTexts.join('\n\n'),
    pageCount: pages.length,
    fontCount,
    cidFontCount,
    decodedStreams,
    objectCount: objects.size,
    diagnostics,
  }
}
