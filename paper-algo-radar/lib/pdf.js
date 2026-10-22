/**
 * 最小 PDF 文本提取器（零依赖）。
 *
 * 能做什么：
 *  - 解 `/FlateDecode` 流（zlib inflate）与未压缩流
 *  - 从内容流里取 `(...) Tj`、`[...] TJ`、`'`、`"` 的文本
 *  - 处理转义（`\\(`、`\\)`、`\\\\`、`\\n`、八进制）与十六进制串 `<...>`
 *  - 按 `Td` / `TD` / `T*` / `ET` 粗分段落
 *
 * **不能做什么**（会如实报告，不假装成功）：
 *  - Type0 / CID 字体：内容流里是字形编号而不是 Unicode，抽出来是乱码
 *  - 扫描件（整页是图）：没有文本算子，抽不出东西
 *  - 加密 / 需要解密口令的 PDF
 *  - 加密 PDF、对象流（ObjStm）内部的内容流
 *
 * 因此本模块返回**诊断信息**，由调用方决定是「用」还是「明确告知用户不支持」。
 *
 * @module paper-algo-radar/pdf
 */
import { inflateSync, inflateRawSync } from 'node:zlib'

import { analyzeText } from './textquality.js'

/** 判断字节里有多少「像文本」的字符（用于识别 CID 乱码）。 */
function textQuality(text) {
  if (text === '') return { printableRatio: 0, cidLike: 0 }
  let printable = 0
  let cidLike = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x20 && code !== 0x7f) printable += 1
    // 私用区 / 替换符 / 控制符：CID 字体常见的表现
    if ((code >= 0xe000 && code <= 0xf8ff) || code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      cidLike += 1
    }
  }
  return { printableRatio: printable / [...text].length, cidLike }
}

/** 解 PDF 字符串字面量里的转义。 */
export function unescapePdfString(raw) {
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
    else if (next === '(') out += '('
    else if (next === ')') out += ')'
    else if (next === '\\') out += '\\'
    else if (next === '\n') out += '' // 行尾续行
    else if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) {
        octal += raw[i + 1]
        i += 1
      }
      out += String.fromCharCode(parseInt(octal, 8))
    } else out += next
  }
  return out
}

/** 十六进制串 `<48656C6C6F>` → 文本；两字节一组时按 UTF-16BE 解。 */
export function hexPdfString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length === 0) return ''
  if (clean.length % 4 === 0) {
    // 常见于 CID 字体的 UTF-16BE
    let out = ''
    for (let i = 0; i < clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16))
    }
    return out
  }
  let out = ''
  for (let i = 0; i < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16))
  }
  return out
}

/** 从一段内容流里抽文本。 */
export function extractTextFromContent(content) {
  const parts = []
  let pending = ''
  const flush = () => {
    if (pending.trim() !== '') parts.push(pending.trim())
    pending = ''
  }

  // 逐个 token 扫描：字符串字面量 / 十六进制串 / 算子
  let i = 0
  const text = String(content)
  while (i < text.length) {
    const ch = text[i]
    if (ch === '(') {
      // 找到配对的右括号（考虑转义与嵌套）
      let depth = 1
      let j = i + 1
      let raw = ''
      while (j < text.length && depth > 0) {
        const c = text[j]
        if (c === '\\') {
          raw += c + (text[j + 1] ?? '')
          j += 2
          continue
        }
        if (c === '(') depth += 1
        if (c === ')') {
          depth -= 1
          if (depth === 0) break
        }
        raw += c
        j += 1
      }
      pending += unescapePdfString(raw)
      i = j + 1
      continue
    }
    if (ch === '<' && text[i + 1] !== '<') {
      const end = text.indexOf('>', i)
      if (end > i) {
        pending += hexPdfString(text.slice(i + 1, end))
        i = end + 1
        continue
      }
    }
    if (ch === 'T' && (text[i + 1] === 'd' || text[i + 1] === 'D' || text[i + 1] === '*')) {
      flush()
      i += 2
      continue
    }
    if (ch === 'E' && text[i + 1] === 'T') {
      flush()
      i += 2
      continue
    }
    if (ch === "'") {
      flush()
      i += 1
      continue
    }
    i += 1
  }
  flush()
  return parts.join('\n')
}

/** 取所有 `stream ... endstream` 的原始字节（返回 Buffer 段）。 */
function streamChunks(buffer) {
  const chunks = []
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  let index = 0
  while (index < buffer.length) {
    const start = buffer.indexOf(marker, index)
    if (start < 0) break
    let dataStart = start + marker.length
    if (buffer[dataStart] === 0x0d) dataStart += 1
    if (buffer[dataStart] === 0x0a) dataStart += 1
    const end = buffer.indexOf(endMarker, dataStart)
    if (end < 0) break
    // 流前面那一段（字典）用来判断过滤器
    const dictStart = Math.max(0, start - 600)
    const dict = buffer.subarray(dictStart, start).toString('latin1')
    chunks.push({ bytes: buffer.subarray(dataStart, end), dict })
    index = end + endMarker.length
  }
  return chunks
}

/**
 * 提取 PDF 文本。
 * @param {Buffer} buffer
 * @returns {{ text: string, streams: number, decoded: number, encrypted: boolean, quality: {printableRatio: number, cidLike: number}, diagnostics: string[] }}
 */
export function extractPdfText(buffer) {
  const diagnostics = []
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { text: '', streams: 0, decoded: 0, encrypted: false, quality: { printableRatio: 0, cidLike: 0, usable: false }, diagnostics: ['空文件'] }
  }
  const head = buffer.subarray(0, 1024).toString('latin1')
  if (!head.includes('%PDF-')) diagnostics.push('文件头里没有 %PDF-，可能不是 PDF')

  const encrypted = /\/Encrypt\s/.test(buffer.subarray(0, 200000).toString('latin1'))
  if (encrypted) diagnostics.push('PDF 已加密（/Encrypt），本工具不解密')

  // 结构性信号：CID/Type0 字体（尤其是 Identity-H）意味着内容流里是字形码，
  // 解开 ToUnicode 映射才拿得到文字——本工具不做这一步，所以先把话说在前面。
  const cidFont = buffer.includes('/Identity-H') || buffer.includes('/Type0')
  if (cidFont) diagnostics.push('PDF 里有 CID/Type0 字体（Identity-H）：本工具不解字形映射，抽出的可能是字形码')

  const chunks = streamChunks(buffer)
  const pieces = []
  let decoded = 0
  let droppedPieces = 0
  for (const chunk of chunks) {
    const isFlate = /\/FlateDecode/.test(chunk.dict)
    let content = null
    if (isFlate) {
      try {
        content = inflateSync(chunk.bytes).toString('latin1')
        decoded += 1
      } catch {
        try {
          content = inflateRawSync(chunk.bytes).toString('latin1')
          decoded += 1
        } catch {
          // 解压失败：跳过（可能是图片或其它编码）
        }
      }
    } else {
      content = chunk.bytes.toString('latin1')
      decoded += 1
    }
    if (content === null) continue
    // 只处理看起来像内容流的部分（含文本算子）
    if (!/\b(Tj|TJ|Td|TD|T\*)\b/.test(content)) continue
    const text = extractTextFromContent(content)
    if (text === '') continue
    // 逐个流判定：二进制流（图片/字体）里偶尔含 Tj/TJ，解出来是字形码或噪声。
    // 整段过滤在这里，而不是只判全文——混合型 PDF 里能保住真正的内容流。
    const piece = analyzeText(text)
    if (!piece.usable || text.length < 20) {
      droppedPieces += 1
      continue
    }
    pieces.push(text)
  }

  const text = pieces.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  const quality = textQuality(text)
  if (droppedPieces > 0) diagnostics.push(`跳过 ${droppedPieces} 个不像正文的流（字形码或二进制）`)
  if (text !== '' && quality.cidLike / Math.max(1, [...text].length) > 0.3) {
    diagnostics.push('抽出来的字符大量落在私用区，字体可能是 CID/Type0（本工具不支持）')
  }
  const report = analyzeText(text)
  if (text !== '' && !report.usable) {
    diagnostics.push(`抽出的文本不像自然语言（${report.reasons.join('；')}），字体可能是 CID/Type0（本工具不支持）`)
  }
  if (text === '') {
    diagnostics.push(
      encrypted ? '加密 PDF 无法提取文本' : '没有可提取的文本（多半是扫描件或纯图 PDF，或只有对象流里的内容）',
    )
  }

  return {
    text,
    streams: chunks.length,
    decoded,
    encrypted,
    quality: { ...quality, ...report, usable: report.usable, cidFont },
    diagnostics,
  }
}
