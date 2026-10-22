/**
 * 种子词典 · 智能优化（元启发式）。
 *
 * 覆盖 2026-10 增补的 18 条元启发式（GA / PSO / SA / BA / ACO / DE / GWO / WOA /
 * SSA / HHO / ABC / MFO / MVO / TLBO / Jaya / GSA / 萤火虫 / 布谷鸟）。
 *
 * 重点守三件事：
 *  1. 别名一律小写——大写缩写（GA / PSO）会触发 §8 R6.5 的条目级大小写敏感，
 *     反而漏掉 "Genetic Algorithm" 这种最常见的写法；
 *  2. 词典无重复 id、无跨条目别名冲突（否则同一句话会被两个算法抢）；
 *  3. 短缩写不误伤普通英文单词（gaussian / basic / database / satisfaction…）。
 *
 * 运行：node test/lexicon-metaheuristic.test.mjs
 */
import { __test } from '../lib/index.js'
import { buildMatchers, extract } from '../lib/extract.js'

const LEXICON = __test.LEXICON
const MATCHERS = buildMatchers(LEXICON)

/** 跑一段正文，返回 `id:次数` 的数组。 */
const hitsOf = (text) => {
  const result = extract(text, MATCHERS, { dictVersion: 'test', depth: 'fulltext' })
  return result.hits.map((hit) => `${hit.id}:${hit.count}`).sort()
}

const META = [
  'genetic-algorithm',
  'particle-swarm',
  'bat-algorithm',
  'simulated-annealing',
  'ant-colony',
  'differential-evolution',
  'grey-wolf',
  'whale-optimization',
  'sparrow-search',
  'harris-hawks',
  'artificial-bee-colony',
  'moth-flame',
  'multi-verse',
  'tlbo',
  'jaya',
  'gravitational-search',
  'firefly',
  'cuckoo-search',
]

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

console.log('\n[1] 词条本身')
{
  const byId = new Map(LEXICON.map((entry) => [entry.id, entry]))
  const missing = META.filter((id) => !byId.has(id))
  check(`${META.length} 条元启发式都在种子里`, missing.length === 0, JSON.stringify(missing))
  check(
    '全部是 MATH 类型、智能优化分类',
    META.every((id) => byId.get(id)?.type === 'MATH' && byId.get(id)?.family === '智能优化'),
    JSON.stringify(META.filter((id) => byId.get(id)?.family !== '智能优化').map((id) => [id, byId.get(id)?.family]))
  )
  check('每条都有中文名', META.every((id) => /[\u4e00-\u9fff]/.test(String(byId.get(id)?.name))))
  check('词典规模 123 条', LEXICON.length === 123, String(LEXICON.length))
  check('别名总量 408 个', LEXICON.reduce((sum, entry) => sum + entry.aliases.length, 0) === 408)
}

console.log('\n[2] 词典自洽：不重复、不抢词')
{
  const ids = LEXICON.map((entry) => entry.id)
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
  check('没有重复 id', duplicateIds.length === 0, JSON.stringify(duplicateIds))

  const owner = new Map()
  const conflicts = []
  for (const entry of LEXICON) {
    for (const alias of entry.aliases) {
      const key = String(alias).toLowerCase()
      if (owner.has(key) && owner.get(key) !== entry.id) conflicts.push([key, owner.get(key), entry.id])
      else owner.set(key, entry.id)
    }
  }
  check('没有跨条目别名冲突', conflicts.length === 0, JSON.stringify(conflicts.slice(0, 5)))

  // R6.5 的触发条件：别名里出现 2–6 位全大写缩写 → 整个条目变大小写敏感
  const uppercaseAbbreviation = /^[A-Z][A-Z0-9]{1,5}$/
  const risky = LEXICON.filter((entry) => entry.aliases.some((alias) => uppercaseAbbreviation.test(alias)))
  check('种子里没有大写缩写别名（不会意外触发大小写敏感）', risky.length === 0, JSON.stringify(risky.map((e) => e.id)))
}

console.log('\n[3] 中文写法')
{
  const hits = hitsOf('本文用遗传算法改进模型，并用粒子群优化调参、模拟退火做全局搜索，最后与蝙蝠算法对比。')
  check('四类都命中', ['genetic-algorithm:1', 'particle-swarm:1', 'simulated-annealing:1', 'bat-algorithm:1'].every((item) => hits.includes(item)), JSON.stringify(hits))
  check('改进粒子群算法归到 particle-swarm', hitsOf('提出改进粒子群算法').includes('particle-swarm:1'))
  check('模拟退火算法只算一次', hitsOf('模拟退火算法').filter((item) => item.startsWith('simulated-annealing')).join() === 'simulated-annealing:1')
  check('蚁群优化 / 差分进化 / 灰狼优化 / 鲸鱼优化', ['ant-colony:1', 'differential-evolution:1', 'grey-wolf:1', 'whale-optimization:1'].every((item) => hitsOf('蚁群优化、差分进化、灰狼优化、鲸鱼优化').includes(item)))
}

console.log('\n[4] 英文全称与大小写')
{
  const text =
    'We compare Genetic Algorithm, Particle Swarm Optimization, Simulated Annealing and Bat Algorithm ' +
    'with GRO / WOA / SSA / HHO / ABC / MFO / MVO / TLBO / Jaya / GSA. ' +
    'Grey Wolf Optimizer and Cuckoo Search, Firefly Algorithm, Multi-verse Optimizer, Harris Hawks Optimization, ' +
    'Artificial Bee Colony, Moth-flame optimization, Gravitational Search Algorithm, Sparrow Search Algorithm, ' +
    'Whale Optimization Algorithm, Teaching-learning-based optimization, Differential Evolution and Ant Colony Optimization.'
  const hits = hitsOf(text)
  check('全称（首字母大写）能命中', hits.includes('genetic-algorithm:1') && hits.includes('particle-swarm:1'), JSON.stringify(hits))
  check('全小写缩写能命中', hits.includes('genetic-algorithm:1') && hits.includes('ant-colony:1'))
  check('复数的 algorithms 也能命中', hitsOf('two genetic algorithms').includes('genetic-algorithm:1'))
  check('整句里 18 类都有命中', META.every((id) => hits.some((item) => item.startsWith(`${id}:`))), JSON.stringify(META.filter((id) => !hits.some((item) => item.startsWith(`${id}:`)))))
}

console.log('\n[5] 短缩写不误伤普通单词')
{
  const clean = [
    'Gaussian process regression and Gaussian noise.',
    'A basic database of satisfaction surveys.',
    'abcdef is not an algorithm.',
    'The TLBOrder field is unrelated.',
    'SAAS platform and sabermetrics analysis.',
  ]
  const hits = clean.flatMap((text) => hitsOf(text))
  check('普通英文单词零命中', hits.length === 0, JSON.stringify(hits))
  check('"Gaussian" 不会被当成 GA', !hitsOf('Gaussian process').some((item) => item.startsWith('genetic-algorithm')))
  check('"database" 不会被当成 BA', !hitsOf('the database').some((item) => item.startsWith('bat-algorithm')))
  check('"satisfaction" 不会被当成 SA', !hitsOf('satisfaction survey').some((item) => item.startsWith('simulated-annealing')))
}

console.log('\n[6] 与既有条目互不干扰')
{
  check('梯度下降不受影响', hitsOf('stochastic gradient descent').includes('sgd:1'))
  check('原有 105 条仍在', LEXICON.filter((entry) => entry.family !== '智能优化').length === 105, String(LEXICON.filter((entry) => entry.family !== '智能优化').length))
  check('智能优化 18 条', LEXICON.filter((entry) => entry.family === '智能优化').length === 18, String(LEXICON.filter((entry) => entry.family === '智能优化').length))
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
