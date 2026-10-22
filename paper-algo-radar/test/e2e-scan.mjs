/**
 * T-02 端到端验收：走真实宿主进程与同源 exact 路由。
 *
 * 用法: node test/e2e-scan.mjs <baseUrl> <token>
 * 前提: 隔离实例已启动，且其 DSH_HOME 指向的数据目录可写。
 */
const [, , baseArg, token] = process.argv
const base = baseArg ?? 'http://127.0.0.1:52699'

const TEXT =
  '摘　要：本文研究空气质量预测问题，目标是给出未来二十四小时的 PM2.5 浓度。' +
  '方法部分使用 LSTM 编码历史序列，并用 Transformer 的注意力机制融合多站点信息，' +
  '在多变量输入上加入位置编码以保留时序顺序。优化器为 Adam，正则项为 KL 散度。' +
  '实验部分与 SVM、随机森林、CNN 三个基线对比，评价指标为 RMSE 与 MAE。' +
  '结果表明混合结构在长预测步长下更稳定，注意力权重集中在早晚高峰时段。' +
  '结论部分总结了本文的贡献，并指出未来将扩展到多城市联合建模与在线学习场景。' +
  '我们同时报告了消融实验：去掉注意力后误差上升约百分之九，去掉循环编码后上升约百分之十四。' +
  '所有实验在同一台机器上用相同的随机种子重复三次，报告的是三次运行的均值与标准差。'

if (TEXT.length < 300) throw new Error('测试正文太短：' + TEXT.length)

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

// 1) 用 token 换 cookie
const boot = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookies = boot.headers.getSetCookie ? boot.headers.getSetCookie() : []
const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
console.log(`登录：HTTP ${boot.status}，cookie 段 ${cookie.split('; ').filter(Boolean).length}`)

const call = async (path, init = {}) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

// 2) 基线
const before = await call('/paper-algo-radar/state')
check('state 可读', before.status === 200 && typeof before.body.paperCount === 'number', JSON.stringify(before.body).slice(0, 120))
console.log(`  基线：${before.body.paperCount} 篇 / ${before.body.algorithmCount} 个算法`)

// 3) 第一次登记（无年份）
const r1 = await call('/paper-algo-radar/scan', {
  method: 'POST',
  body: JSON.stringify({ title: 'T-02 端到端验证论文', text: TEXT, fields: '时序预测' }),
})
if (!r1.body?.result) {
  console.log('  第一次登记失败：' + JSON.stringify(r1.body).slice(0, 200))
  process.exit(2)
}
check('created=true', r1.body.result.created === true)
check('命中算法 > 0', r1.body.result.total > 0, String(r1.body.result.total))
check('chars 是数字', typeof r1.body.result.chars === 'number' && r1.body.result.chars > 300, String(r1.body.result.chars))
check('depth 是 fulltext', r1.body.result.depth === 'fulltext', String(r1.body.result.depth))
check('hits 是数组且带 id', Array.isArray(r1.body.result.hits) && typeof r1.body.result.hits[0]?.id === 'string')
check('返回值里没有正文', !JSON.stringify(r1.body.result).includes('摘　要'))
const idA = r1.body.result.paper.id
console.log(`  id=${idA} 命中=${r1.body.result.total} 字符=${r1.body.result.chars}`)

// 4) 第二次登记（补年份）—— E10 的核心
const r2 = await call('/paper-algo-radar/scan', {
  method: 'POST',
  body: JSON.stringify({ title: 'T-02 端到端验证论文', text: TEXT, year: 2023, fields: '时序预测' }),
})
check('created=false', r2.body?.result?.created === false)
check('id 不变', r2.body?.result?.paper?.id === idA, String(r2.body?.result?.paper?.id))
check('年份被更新为 2023', r2.body?.result?.paper?.year === 2023, String(r2.body?.result?.paper?.year))

// 5) 第三次：同一篇但标题变了、改用 arXiv id 之外的 doi 通道无法构造；用 title 变体 + 同 doi 不可行，
//    这里改为验证「论文数只 +1」
const after = await call('/paper-algo-radar/state')
check('论文数只 +1', after.body.paperCount - before.body.paperCount === 1, `${before.body.paperCount} → ${after.body.paperCount}`)

const mine = (after.body.papers ?? []).filter((p) => p.title === 'T-02 端到端验证论文')
check('库里只有一条同标题记录', mine.length === 1, String(mine.length))
check('落库年份 = 2023', mine[0]?.year === 2023, String(mine[0]?.year))

// 6) 清理：删掉这篇，恢复基线
const removed = await call('/paper-algo-radar/remove', {
  method: 'POST',
  body: JSON.stringify({ paperId: idA }),
})
const removal = removed.body?.removed ?? removed.body?.result ?? {}
check('删除返回 existed=true', removal.existed === true, JSON.stringify(removed.body).slice(0, 160))
check(
  '删除同时清了键',
  typeof removal.removedKeys === 'number' && removal.removedKeys >= 1,
  String(removal.removedKeys)
)

const final = await call('/paper-algo-radar/state')
check('回到基线篇数', final.body.paperCount === before.body.paperCount, `${final.body.paperCount} vs ${before.body.paperCount}`)

console.log(`\n${fail === 0 ? '端到端通过' : '端到端有失败'}：${pass} passed, ${fail} failed`)
// 不用 process.exit：fetch 的 keep-alive 连接还开着，硬退出会触发 Windows 上的 libuv 断言
process.exitCode = fail === 0 ? 0 : 1
