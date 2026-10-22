/**
 * 正文可用性判定（lib/textquality.js）。
 *
 * 这层是「乱码进库」的最后一道闸门：PDF 抽出的字形码、被误当正文的二进制，
 * 共同特征是「字符很多、没有一个词」。用与语言无关的比例指标判定。
 *
 * 运行：node test/textquality.test.mjs
 */
import { analyzeText, sanitizeText, TEXT_QUALITY_LIMITS } from '../lib/textquality.js'

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

const ZH =
  '本文提出一种基于 LSTM 与 CRF 的命名实体识别方法。方法部分用双向 LSTM 编码上下文，' +
  '用 CRF 建模标签转移，优化器使用 Adam。实验部分与 SVM、随机森林对比，评价指标为 F1。' +
  '结论总结了方法的适用边界，并公开预处理脚本与超参数配置。'
const EN =
  'This paper studies air quality forecasting with machine learning. We compare LSTM, GRU and ' +
  'gradient boosting on three public datasets, report RMSE and MAE, and analyse the ablation results.'

console.log('\n[1] 正常正文必须判为可用')
{
  const zh = analyzeText(ZH)
  check('中文正文可用', zh.usable, JSON.stringify(zh.reasons))
  check('中文常见字占比 ≈ 1', zh.common > 0.98, String(zh.common))
  check('中文控制符为 0', zh.control === 0, String(zh.control))

  const en = analyzeText(EN)
  check('英文正文可用', en.usable, JSON.stringify(en.reasons))
  check('英文常见字占比 ≈ 1', en.common > 0.99, String(en.common))

  const mixed = analyzeText(ZH + '\n' + EN)
  check('中英混排可用', mixed.usable, JSON.stringify(mixed.reasons))
}

console.log('\n[2] 字形码 / 二进制必须判为不可用')
{
  // CID 字形码：低码位控制符（Identity-H 子集最常见）
  const glyph = Array.from({ length: 500 }, (_, i) => String.fromCharCode(1 + (i % 31))).join('')
  const control = analyzeText(glyph)
  check('控制符多 → 不可用', control.usable === false)
  check('理由里点出控制字符', control.reasons.some((r) => r.includes('控制字符')), JSON.stringify(control.reasons))

  // 私用区字符：CID 字体没有 ToUnicode 时的典型产物
  const pua = Array.from({ length: 500 }, (_, i) => String.fromCharCode(0xe000 + (i % 200))).join('')
  const privateUse = analyzeText(pua)
  check('私用区多 → 不可用', privateUse.usable === false)
  check('理由里点出私用区', privateUse.reasons.some((r) => r.includes('私用区')), JSON.stringify(privateUse.reasons))

  // 解码失败留下的替换符
  const broken = '正常文字'.repeat(20) + '\uFFFD'.repeat(60)
  const replacement = analyzeText(broken)
  check('替换符多 → 不可用', replacement.usable === false)
  check('理由里点出替换符', replacement.reasons.some((r) => r.includes('替换符')), JSON.stringify(replacement.reasons))

  // 异体文字（西里尔 / 埃塞俄比亚文）：随机字节按 UTF-8 解出来的样子
  const exotic = Array.from({ length: 400 }, (_, i) => String.fromCharCode(0x1200 + (i % 300))).join('')
  const weird = analyzeText(exotic)
  check('异体文字占比高 → 不可用', weird.usable === false)
  check('理由里点出常见文字占比', weird.reasons.some((r) => r.includes('常见文字')), JSON.stringify(weird.reasons))

  check('空串 → 不可用', analyzeText('').usable === false)
  check('空白串 → 不可用', analyzeText('   \n\t  ').usable === false)
}

console.log('\n[3] 清洗：只洗判定通过之后的正文')
{
  const dirty = '第一行\r\n第二行\u0001有控制符\u007f\u009f，还有\u00a0不换行空格\n\n\n\n第四行'
  const clean = sanitizeText(dirty)
  check('CRLF 归一成 LF', !clean.includes('\r'), JSON.stringify(clean))
  check('去掉 C0/C1 控制符', !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(clean), JSON.stringify(clean))
  check('不换行空格换成普通空格', !clean.includes('\u00a0'), JSON.stringify(clean))
  check('压缩多余空行', !/\n{3,}/.test(clean), JSON.stringify(clean))
  check('去掉首尾空白', clean === clean.trim(), JSON.stringify(clean))
  check('正文内容仍然保留', clean.includes('第一行') && clean.includes('第四行'))

  const same = sanitizeText(ZH)
  check('干净正文不被改动', same === ZH, JSON.stringify(same.slice(0, 30)))
}

console.log('\n[4] 阈值是显式的')
{
  check('控制符上限 2%', TEXT_QUALITY_LIMITS.maxControl === 0.02, String(TEXT_QUALITY_LIMITS.maxControl))
  check('常见文字下限 90%', TEXT_QUALITY_LIMITS.minCommon === 0.9, String(TEXT_QUALITY_LIMITS.minCommon))
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
