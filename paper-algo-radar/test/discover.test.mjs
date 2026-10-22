/**
 * FR-6.8 验收：radar_discover 的「检索源可选 + 年份/引用数过滤」契约。
 *
 * 过滤逻辑本身（URL 参数、合并后剔除）在 sources.test.mjs 里用假服务器验；
 * 这里只验模型看到的那一面：参数、输出 schema、卡片说明。
 *
 * 运行：node test/discover.test.mjs
 */
const { __test } = await import('../lib/index.js')

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

const fakeCtx = { tools: { get: () => undefined } }
const tool = __test.buildDiscoverTool(() => null, fakeCtx)

console.log('\n[1] 参数契约')
{
  const p = tool.parameters
  check('工具名 radar_discover', tool.name === 'radar_discover')
  check('query 仍必填', JSON.stringify(p.required) === JSON.stringify(['query']))
  check('additionalProperties=false', p.additionalProperties === false)
  check('支持 sources', p.properties.sources?.type === 'array')
  check('sources 只允许三个源', JSON.stringify(p.properties.sources?.items?.enum) === JSON.stringify(['openalex', 'crossref', 'arxiv']))
  check('支持 yearFrom / yearTo', p.properties.yearFrom?.type === 'number' && p.properties.yearTo?.type === 'number')
  check('支持 minCitations', p.properties.minCitations?.type === 'number')
  check('每个新参数都有 description', ['sources', 'yearFrom', 'yearTo', 'minCitations'].every((key) => typeof p.properties[key]?.description === 'string' && p.properties[key].description.length > 0))
  check('描述写清按年份/引用数过滤', tool.description.includes('年份') && tool.description.includes('引用数'))
}

console.log('\n[2] 输出契约')
{
  const schema = tool.output.schema
  check('声明了 filters', schema.properties.filters?.type === 'object')
  check('items 仍是数组', schema.properties.items?.type === 'array')
}

console.log('\n[3] 卡片：有过滤时如实说明')
{
  const value = {
    query: '空气质量预测',
    via: 'crossref',
    sources: [{ name: 'crossref', status: 'ok', count: 1 }],
    filters: { yearFrom: 2022, yearTo: 2022, minCitations: 10, dropped: { year: 1, citations: 2 }, total: 4 },
    items: [{ title: '一篇候选', year: 2022, inLibrary: false }],
  }
  const text = tool.output.render({}, value).map((block) => block.text).join('\n')
  check('含年份区间', text.includes('2022–2022'), text)
  check('含引用下限', text.includes('引用 ≥10'), text)
  check('含剔除条数（1+2=3）', text.includes('剔除 3 条'), text)
  check('候选正文仍在', text.includes('一篇候选'))
}

console.log('\n[4] 卡片：空结果也保留过滤说明')
{
  const value = {
    query: 'x',
    filters: { yearFrom: 2020, yearTo: 2020, minCitations: null, dropped: { year: 0, citations: 0 }, total: 0 },
    items: [],
  }
  const text = tool.output.render({}, value).map((block) => block.text).join('\n')
  check('说明没有候选', text.includes('没有检索到候选'), text)
  check('仍显示筛选条件', text.includes('筛选：') && text.includes('2020–2020'), text)
}

console.log('\n[5] 卡片：没过滤时不显示筛选行')
{
  const text = tool.output
    .render({}, { query: 'x', filters: { yearFrom: null, yearTo: null, minCitations: null, dropped: { year: 0, citations: 0 }, total: 1 }, items: [{ title: 'A', year: null }] })
    .map((block) => block.text)
    .join('\n')
  check('不出现「筛选：」', !text.includes('筛选：'), text)
}

console.log(`\n全部通过：${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
