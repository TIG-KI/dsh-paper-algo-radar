/**
 * 走真实宿主路由验证 W1.0：正文留存 + 重算。
 *
 * 用法：node test/e2e-reextract.mjs <baseUrl> <token>
 */
const [, , baseArg, token] = process.argv
const base = baseArg ?? 'http://127.0.0.1:52699'

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

const TEXT_BASE =
  '摘　要：本文研究空气质量预测。方法上使用 LSTM 与 Transformer 的注意力机制，优化器为 Adam。' +
  '实验与 SVM、随机森林、CNN 基线对比，指标为 RMSE 与 MAE，并报告消融结果。' +
  '结论总结贡献，指出未来扩展到多城市联合建模与在线学习场景，并公开预处理脚本。'
const FILLER = '补充说明用于满足最小正文长度，不引入额外方法名称。'
let text = TEXT_BASE
while (text.length < 340) text += FILLER

const boot = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (boot.headers.getSetCookie ? boot.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ')

const call = async (path, init = {}) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const before = await call('/paper-algo-radar/state')
console.log(`基线：${before.body.paperCount} 篇 · 有正文 ${before.body.hasTextCount} 篇 · 旧口径 ${before.body.stalePapers} 篇`)

// 1) 重算预览：旧论文没有正文 → 应该全部跳过，且不改库
const preview = await call('/paper-algo-radar/reextract', {
  method: 'POST',
  body: JSON.stringify({ scope: 'stale' }),
})
check('默认 dryRun=true', preview.body.dryRun === true)
check('total = 旧口径篇数', preview.body.total === before.body.stalePapers, `${preview.body.total} vs ${before.body.stalePapers}`)
check('没有正文 → 全部 skippedNoText', preview.body.skippedNoText === preview.body.total, String(preview.body.skippedNoText))
check('预览 changed=0', preview.body.changed === 0, String(preview.body.changed))

const afterPreview = await call('/paper-algo-radar/state')
check('预览没改库', afterPreview.body.staleMentions === before.body.staleMentions, `${afterPreview.body.staleMentions} vs ${before.body.staleMentions}`)

// 2) 登记一篇新论文：应立刻留存正文
const added = await call('/paper-algo-radar/scan', {
  method: 'POST',
  body: JSON.stringify({ title: 'W1.0 正文留存验证', text, fields: '时序预测' }),
})
if (!added.body?.result) {
  console.log('  登记失败：' + JSON.stringify(added.body).slice(0, 200))
  process.exitCode = 2
} else {
  const id = added.body.result.paper.id
  check('登记成功', added.body.result.created === true)
  const afterAdd = await call('/paper-algo-radar/state')
  check('hasTextCount +1', afterAdd.body.hasTextCount === before.body.hasTextCount + 1, `${afterAdd.body.hasTextCount}`)
  const row = (afterAdd.body.papers ?? []).find((p) => p.id === id)
  check('论文行带 hasText=true', row?.hasText === true)

  // 3) 对这篇重算：正文在，结果应与登记时一致（changed=false）
  const one = await call('/paper-algo-radar/reextract', {
    method: 'POST',
    body: JSON.stringify({ scope: 'ids', ids: [id], dryRun: false }),
  })
  check('ids 重算 total=1', one.body.total === 1, String(one.body.total))
  check('skippedNoText=0', one.body.skippedNoText === 0, String(one.body.skippedNoText))
  check('无变化（正文与词典都没动）', one.body.changed === 0, String(one.body.changed))

  // 4) 清理
  const removed = await call('/paper-algo-radar/remove', {
    method: 'POST',
    body: JSON.stringify({ paperId: id }),
  })
  check('删除成功', removed.body?.removed?.existed === true)
  const final = await call('/paper-algo-radar/state')
  check('回到基线', final.body.paperCount === before.body.paperCount && final.body.hasTextCount === before.body.hasTextCount)
}

console.log(`\n${fail === 0 ? '端到端通过' : '端到端有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
