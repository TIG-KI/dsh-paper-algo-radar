/**
 * 正文可用性判定（防止「字形码 / 二进制」当成正文存进库）。
 *
 * 起因：真实 PDF 里有 Type0/CID 字体时，抽出来的不是文字而是字形码；
 * 二进制流（图片、字体）里偶尔含 Tj/TJ 也会被当成内容流。两者都会产出
 * 「字符很多、但没有一个词」的文本，长度闸门拦不住，最后以乱码进库。
 * 这里用**与语言无关的比例指标**判定：控制符、替换符、私用区、常见文字占比。
 *
 * 设计约束：纯函数、零依赖、不碰 IO，任何来源（PDF / 粘贴 / 导入）都能先过一遍。
 *
 * @module paper-algo-radar/textquality
 */

/** 控制符上限：正常正文里除了 \n \t 基本不该有控制符。 */
const MAX_CONTROL = 0.02
/** 替换符上限（U+FFFD：解码失败的痕迹）。 */
const MAX_REPLACEMENT = 0.01
/** 私用区上限（CID 字体常见的表现）。 */
const MAX_PRIVATE_USE = 0.01
/** 常见文字占比下限：拉丁字母、CJK、标点、空白、常见数学/全角符号。 */
const MIN_COMMON = 0.9

/** 常见文字：ASCII 可打印 + 空白 + 拉丁补充 + CJK/CJK 标点 + 全角 + 常见标点。 */
function isCommonCodePoint(code) {
  return (
    (code >= 0x20 && code <= 0x7e) ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0xa0 && code <= 0x24f) ||
    (code >= 0x2010 && code <= 0x2027) ||
    (code >= 0x2030 && code <= 0x205e) ||
    (code >= 0x20a0 && code <= 0x20cf) ||
    (code >= 0x2100 && code <= 0x22ff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

/** C0/C1 控制符（保留 \n \t \r）。 */
function isControlCodePoint(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

const pct = (value) => `${(value * 100).toFixed(1)}%`

/**
 * 分析一段正文的可用性。
 * @param {string} text
 * @returns {{chars:number, control:number, replacement:number, privateUse:number, common:number,
 *   letters:number, usable:boolean, reasons:string[]}}
 */
export function analyzeText(text) {
  const body = String(text ?? '')
  let chars = 0
  let control = 0
  let replacement = 0
  let privateUse = 0
  let common = 0
  let letters = 0
  for (const ch of body) {
    const code = ch.codePointAt(0)
    chars += 1
    if (isCommonCodePoint(code)) common += 1
    if (isControlCodePoint(code)) control += 1
    if (code === 0xfffd) replacement += 1
    if (code >= 0xe000 && code <= 0xf8ff) privateUse += 1
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff)
    ) {
      letters += 1
    }
  }
  const ratio = (n) => (chars === 0 ? 0 : n / chars)
  const metrics = {
    chars,
    control: ratio(control),
    replacement: ratio(replacement),
    privateUse: ratio(privateUse),
    common: ratio(common),
    letters: ratio(letters),
  }
  const reasons = []
  if (chars === 0) {
    reasons.push('没有文本')
  } else {
    if (metrics.control > MAX_CONTROL) reasons.push(`控制字符占 ${pct(metrics.control)}（上限 ${pct(MAX_CONTROL)}）`)
    if (metrics.common < MIN_COMMON) reasons.push(`常见文字只占 ${pct(metrics.common)}（下限 ${pct(MIN_COMMON)}）`)
    if (metrics.replacement > MAX_REPLACEMENT) {
      reasons.push(`替换符占 ${pct(metrics.replacement)}（上限 ${pct(MAX_REPLACEMENT)}）`)
    }
    if (metrics.privateUse > MAX_PRIVATE_USE) {
      reasons.push(`私用区字符占 ${pct(metrics.privateUse)}（上限 ${pct(MAX_PRIVATE_USE)}）`)
    }
    if (metrics.letters === 0) reasons.push('没有任何字母或汉字（只有符号或空白）')
  }
  return { ...metrics, usable: reasons.length === 0, reasons }
}

/**
 * 去掉控制符、统一换行、压缩过量空白行。
 * 只在**判定可用之后**调用；先判定再清洗，否则控制符比例会被洗没。
 */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const TEXT_QUALITY_LIMITS = {
  maxControl: MAX_CONTROL,
  maxReplacement: MAX_REPLACEMENT,
  maxPrivateUse: MAX_PRIVATE_USE,
  minCommon: MIN_COMMON,
}
