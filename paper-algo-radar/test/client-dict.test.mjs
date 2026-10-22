/**
 * FR-2.10：词典页类型筛选 —— 组件级验证（真渲染，不是断言源码）。
 *
 * 背景：v0.2 的 DL / ML / MATH 三个按钮只是「新增条目的类型选择」，
 * 点它们不会筛列表；用户点了以为在筛选，看起来就是"没反应"。
 *
 * 做法：直接加载浏览器 bundle（假 `window.__ModuleLoader__` 接住工厂），
 * 用一套极简 hooks 渲染器把真实的 DictionaryView 组件渲染成元素树，
 * 再点筛选按钮、数表格行数——验证的是**组件行为**，不是字符串。
 *
 * 运行：node test/client-dict.test.mjs
 */

const ENTRIES = [
  { id: 'gbdt', name: 'GBDT', type: 'ML', aliases: ['gbdt'], papers: 2, origin: 'builtin', status: 'active' },
  { id: 'xgboost', name: 'XGBoost', type: 'ML', aliases: ['xgboost'], papers: 2, origin: 'builtin', status: 'active' },
  { id: 'cnn', name: 'CNN', type: 'DL', aliases: ['cnn'], papers: 1, origin: 'builtin', status: 'active' },
  { id: 'lstm', name: 'LSTM', type: 'DL', aliases: ['lstm'], papers: 1, origin: 'builtin', status: 'active' },
  { id: 'transformer', name: 'Transformer', type: 'DL', aliases: ['transformer'], papers: 1, origin: 'builtin', status: 'active' },
  { id: 'pca', name: 'PCA', type: 'MATH', aliases: ['pca'], papers: 1, origin: 'builtin', status: 'active' },
]

const DICT = { version: '2026.10.1', count: ENTRIES.length, customCount: 0, disabledCount: 0, entries: ENTRIES }

// ── 极简 hooks 渲染器：够渲染函数组件、触发 setState、跑 useEffect ──────────
function makeRuntime() {
  const store = new Map() // path → { hooks: [], effectDeps: Map }
  let currentPath = ''
  let hookIndex = 0
  let dirty = false
  let pendingEffects = []

  const slot = (path) => {
    if (!store.has(path)) store.set(path, { hooks: [], effectDeps: new Map() })
    return store.get(path)
  }

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    createContext: (value) => ({ _value: value }),
    useContext: (context) => context?._value ?? {},
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useState: (initial) => {
      const box = slot(currentPath)
      const index = hookIndex++
      if (!(index in box.hooks)) box.hooks[index] = initial
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(box.hooks[index]) : next
        if (!Object.is(value, box.hooks[index])) {
          box.hooks[index] = value
          dirty = true
        }
      }
      return [box.hooks[index], setValue]
    },
    useEffect: (fn, deps) => {
      const box = slot(currentPath)
      const index = hookIndex++
      const depsJson = JSON.stringify(deps ?? null)
      if (box.effectDeps.get(index) !== depsJson) {
        box.effectDeps.set(index, depsJson)
        pendingEffects.push(fn)
      }
    },
  }

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}[${index}]`))
    if (typeof node.type === 'function') {
      const compPath = `${path}>${node.type.name || 'Anon'}`
      const prevPath = currentPath
      const prevIndex = hookIndex
      currentPath = compPath
      hookIndex = 0
      let output
      try {
        output = node.type(node.props)
      } finally {
        currentPath = prevPath
        hookIndex = prevIndex
      }
      return renderNode(output, compPath)
    }
    return {
      type: node.type,
      props: node.props,
      children: node.children.map((child, index) => renderNode(child, `${path}/${node.type}[${index}]`)),
    }
  }

  /** 渲染到稳定：执行 effect → 等 promise 回调 → 有 setState 就再渲染。 */
  async function flush(root) {
    let tree = null
    for (let pass = 0; pass < 20; pass += 1) {
      dirty = false
      pendingEffects = []
      tree = renderNode(root, 'root')
      while (pendingEffects.length > 0) pendingEffects.shift()()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) return tree
    }
    throw new Error('渲染没有稳定下来（effect 一直在 setState）')
  }

  return { React, flush }
}

const { React, flush } = makeRuntime()

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      captured = spec.factory((name) => {
        if (name === 'react') return React
        throw new Error(`测试不提供模块：${name}`)
      })
    },
  },
}
globalThis.fetch = async (url) => {
  const body = url.includes('/dictionary') ? DICT : url.includes('/candidates') ? { items: [] } : {}
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

await import('../lib/client.js')

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

const __test = captured?.__test
check('bundle 能加载并暴露 __test', __test !== undefined, JSON.stringify(Object.keys(captured ?? {})))
check('宿主契约 apply / inject 仍在', typeof captured?.apply === 'function' && captured?.inject !== undefined)

const { filterDictEntries, countDictTypes, DictionaryView } = __test ?? {}

// ── 元素树工具 ──────────────────────────────────────────────────────────
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}
const findAll = (node, predicate, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}
const rows = (tree) => {
  const [tbody] = findAll(tree, (node) => node.type === 'tbody')
  return (tbody?.children ?? []).filter((node) => node?.type === 'tr')
}
const rowTypes = (tree) =>
  rows(tree).map((row) => {
    const cells = (row.children ?? []).filter((node) => node?.type === 'td')
    return textOf(cells[2])
  })
const chip = (tree, key) =>
  findAll(tree, (node) => node.type === 'button' && node.props?.['data-radar-dict-filter-chip'] === key)[0]

console.log('\n[1] 按类型筛选（纯函数）')
{
  check('ALL 返回全部', filterDictEntries(ENTRIES, 'ALL').length === 6)
  check('DL 只返回 DL', filterDictEntries(ENTRIES, 'DL').every((entry) => entry.type === 'DL'))
  check('未知类型返回空', filterDictEntries(ENTRIES, 'XYZ').length === 0)
  check('入参不是数组也不炸', filterDictEntries(undefined, 'DL').length === 0 && filterDictEntries(null, 'ALL').length === 0)
  const counts = countDictTypes(ENTRIES)
  check('DL=3 / ML=2 / MATH=1', counts.DL === 3 && counts.ML === 2 && counts.MATH === 1, JSON.stringify(counts))
  check('忽略未知类型', countDictTypes([...ENTRIES, { id: 'x', type: 'OTHER' }]).DL === 3)
}

console.log('\n[2] 组件渲染：筛选按钮真的会筛表格')
{
  const tree = await flush(React.createElement(DictionaryView, { onChanged: () => {} }))
  check('词典视图已就绪（不是加载态）', textOf(tree).includes('按类型筛选'), textOf(tree).slice(0, 60))
  check('默认渲染全部 6 行', rows(tree).length === 6, String(rows(tree).length))
  check('筛选按钮 4 个（全部 / DL / ML / MATH）', findAll(tree, (n) => n.props?.['data-radar-dict-filter-chip']).length === 4)
  check(
    '「新条目类型」是另一组控件（3 个，带各自的 data 属性）',
    findAll(tree, (n) => n.props?.['data-radar-dict-newtype']).length === 3
  )
  check('筛选按钮上带计数', textOf(chip(tree, 'DL')).trim() === 'DL 3', textOf(chip(tree, 'DL')).trim())

  chip(tree, 'DL').props.onClick()
  let next = await flush(React.createElement(DictionaryView, { onChanged: () => {} }))
  check('点 DL 后只剩 3 行', rows(next).length === 3, String(rows(next).length))
  check('且每行类型都是 DL', rowTypes(next).every((type) => type === 'DL'), JSON.stringify(rowTypes(next)))
  check('显示「3 / 6 条」', textOf(next).includes('显示 3 / 6 条'), textOf(next).slice(-80))

  chip(next, 'MATH').props.onClick()
  next = await flush(React.createElement(DictionaryView, { onChanged: () => {} }))
  check('点 MATH 后只剩 1 行', rows(next).length === 1, String(rows(next).length))
  check('且类型是 MATH', rowTypes(next)[0] === 'MATH', JSON.stringify(rowTypes(next)))

  chip(next, 'ALL').props.onClick()
  next = await flush(React.createElement(DictionaryView, { onChanged: () => {} }))
  check('点「全部」回到 6 行', rows(next).length === 6, String(rows(next).length))
  check('不再显示「显示 N / M 条」', !textOf(next).includes('显示 6 / 6 条'))
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
