/**
 * T-03 验收：v0.2 快照迁移（§10.1 迁移器）。
 *
 * 两部分：
 *  1) 合成快照——覆盖 id 重映射、depth 推断、章节键归一、dictVersion 回填、孤儿提及、键冲突、幂等；
 *  2) 真实快照——如果本机存在 v0.2 的 store.json，只读校验迁移结果（绝不写回）。
 *
 * 运行：node test/migrate.test.mjs
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { migrateSnapshot, SCHEMA_VERSION, LEGACY_DICT_VERSION, SECTION_KEYS } from '../lib/migrate.js'
import { normalizeTitleKey } from '../lib/keys.js'

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

const NOW = 1_700_000_000_000

console.log('\n[1] 合成 v0.2 快照')
{
  const legacy = {
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    papers: {
      p_0123456789abcdef: {
        id: 'p_0123456789abcdef',
        title: 'Legacy  Paper  With  Spaces',
        doi: '10.1234/LEGACY',
        chars: 5000,
        // 没有 depth / hasText / rawChars / textHash / dedupeKey / isSample / status
        fields: ['NLP'],
        readAt: 1,
        updatedAt: 2,
      },
      p_fedcba9876543210: {
        id: 'p_fedcba9876543210',
        title: 'Short Abstract Only',
        chars: 218,
        fields: [],
        readAt: 3,
        updatedAt: 4,
      },
      bogus_id: {
        id: 'bogus_id',
        title: 'Bad Id Paper',
        chars: 900,
        fields: ['未分类'],
      },
    },
    algorithms: { transformer: { id: 'transformer', name: 'Transformer', type: 'DL' } },
    mentions: {
      'p_0123456789abcdef::transformer': {
        paperId: 'p_0123456789abcdef',
        algorithmId: 'transformer',
        count: 7,
        sections: { abstract: 1, intro: 2, experiments: 4 },
        snippets: ['a', 'b', 'c', 'd'],
        // 没有 dictVersion / role
      },
      'bogus_id::transformer': {
        paperId: 'bogus_id',
        algorithmId: 'transformer',
        count: 2,
        sections: {},
      },
      'p_0123456789abcdef::ghost': {
        paperId: 'ghost_paper',
        algorithmId: 'ghost',
        count: 1,
      },
    },
    meta: { state: { key: 'state', lastScanAt: 9, schemaVersion: 1 } },
  }

  const { data, report } = migrateSnapshot(legacy, { now: NOW })

  check('版本升到 2', data.version === SCHEMA_VERSION, String(data.version))
  check('报告记录了来源版本 1', report.fromVersion === 1)
  check('三篇论文都保留', Object.keys(data.papers).length === 3, String(Object.keys(data.papers).length))

  const a = data.papers.p_0123456789abcdef
  check('合法 id 保持不变', a !== undefined)
  check('depth 由 chars 推断为 fulltext', a?.depth === 'fulltext', a?.depth)
  check('dedupeKey 取 doi', a?.dedupeKey === 'doi:10.1234/legacy', a?.dedupeKey)
  check('hasText 补成 false', a?.hasText === false)
  check('rawChars 补成 0', a?.rawChars === 0)
  check('textHash 补成空串', a?.textHash === '')
  check('isSample 补成 false', a?.isSample === false)
  check('status 补成 null', a?.status === null)
  check('doi 已小写归一', a?.doi === '10.1234/legacy', a?.doi)

  const b = data.papers.p_fedcba9876543210
  check('chars=218 推断为 abstract', b?.depth === 'abstract', b?.depth)
  check('空 fields 补成未分类', JSON.stringify(b?.fields) === JSON.stringify(['未分类']), JSON.stringify(b?.fields))

  const badIds = Object.keys(data.papers).filter((id) => id !== 'p_0123456789abcdef' && id !== 'p_fedcba9876543210')
  check('非法 id 被换成 p_<16hex>', badIds.length === 1 && /^p_[0-9a-f]{16}$/.test(badIds[0]), badIds.join(','))
  check('报告记录了 id 重映射', report.remappedIds.length >= 1, JSON.stringify(report.remappedIds))

  const m = data.mentions['p_0123456789abcdef::transformer']
  check('提及保留', m !== undefined)
  check('dictVersion 回填为 v0.2-legacy', m?.dictVersion === LEGACY_DICT_VERSION, m?.dictVersion)
  check('role 补成 null', m?.role === null)
  check('sections.experiments 归一到 experiment', m?.sections.experiment === 4, JSON.stringify(m?.sections))
  check('sections 补齐 8 个键', Object.keys(m?.sections ?? {}).length === SECTION_KEYS.length + 0 || SECTION_KEYS.every((k) => k in (m?.sections ?? {})), JSON.stringify(Object.keys(m?.sections ?? {})))
  check('snippets 截到 3 条', m?.snippets.length === 3, String(m?.snippets.length))

  check('非法 id 的提及被重映射过来', data.mentions[`${badIds[0]}::transformer`] !== undefined)
  check('孤儿提及被丢弃', Object.values(data.mentions).every((x) => data.papers[x.paperId] !== undefined))
  check('报告记录了丢弃数', report.droppedMentions === 1, String(report.droppedMentions))

  check('三键重建成功', Object.keys(data.paperKeys).length >= 3, String(Object.keys(data.paperKeys).length))
  check('标题键符合规范化', data.paperKeys['title:' + normalizeTitleKey('Legacy Paper With Spaces')] === 'p_0123456789abcdef')
  check('meta.schemaVersion 升到 2', data.meta.state.schemaVersion === 2)

  console.log('\n[2] 幂等')
  const again = migrateSnapshot(data, { now: NOW })
  check('二次迁移 changed=false', again.report.changed === false, JSON.stringify(again.report))
  check('二次迁移论文数不变', Object.keys(again.data.papers).length === 3)
  check('二次迁移提及数不变', Object.keys(again.data.mentions).length === Object.keys(data.mentions).length)
  check('二次迁移结果逐字节一致', JSON.stringify(again.data) === JSON.stringify(data))

  console.log('\n[3] 键冲突')
  const conflict = migrateSnapshot({
    version: 1,
    papers: {
      p_aaaaaaaaaaaaaaaa: { id: 'p_aaaaaaaaaaaaaaaa', title: 'Same Title', chars: 400, fields: ['x'] },
      p_bbbbbbbbbbbbbbbb: { id: 'p_bbbbbbbbbbbbbbbb', title: 'Same Title', chars: 400, fields: ['x'] },
    },
    mentions: {},
    meta: {},
  })
  check('同标题两篇被记为键冲突', conflict.report.keyConflicts.length === 1, JSON.stringify(conflict.report.keyConflicts))
  check('冲突时保留先到的那篇', conflict.report.keyConflicts[0]?.kept === 'p_aaaaaaaaaaaaaaaa')
}

console.log('\n[4] 真实快照（只读）')
{
  const real = join(homedir(), '.dsh', 'plugin-data', 'paper-algo-radar', 'store.json')
  let raw = null
  try {
    raw = await readFile(real, 'utf8')
  } catch {
    console.log('  · 跳过：本机没有 v0.2 的 store.json')
  }
  if (raw !== null) {
    const parsed = JSON.parse(raw)
    const before = {
      papers: Object.keys(parsed.papers ?? {}).length,
      mentions: Object.keys(parsed.mentions ?? {}).length,
    }
    const { data, report } = migrateSnapshot(parsed)
    console.log(`  · 文件版本 ${parsed.version ?? '(无)'} → ${data.version}；${before.papers} 篇 / ${before.mentions} 条提及`)
    check('论文数不变', Object.keys(data.papers).length === before.papers, `${Object.keys(data.papers).length} vs ${before.papers}`)
    check('提及数不变（无孤儿时）', Object.keys(data.mentions).length === before.mentions - report.droppedMentions)
    check('所有提及都有 dictVersion', Object.values(data.mentions).every((m) => typeof m.dictVersion === 'string'))
    // 真实库可能已被 reextract 刷成当前口径，所以不能断言「一定有 legacy 标记」；
    // 要断言的是迁移契约本身：入参里缺 dictVersion 的提及，迁移后必须补成 v0.2-legacy。
    const backfillIds = Object.keys(parsed.mentions ?? {})
      .filter((id) => typeof parsed.mentions[id]?.dictVersion !== 'string' && id in data.mentions)
    check(
      '无 dictVersion 的旧提及被回填为 v0.2-legacy',
      backfillIds.every((id) => data.mentions[id].dictVersion === LEGACY_DICT_VERSION),
      `${backfillIds.length} 条待回填`,
    )
    check('sections 只剩 experiment', Object.values(data.mentions).every((m) => !('experiments' in m.sections)))
    check('所有论文都有 hasText', Object.values(data.papers).every((p) => typeof p.hasText === 'boolean'))
    check('所有论文都有 dedupeKey', Object.values(data.papers).every((p) => typeof p.dedupeKey === 'string'))
    check('三键条数 ≥ 论文数', Object.keys(data.paperKeys).length >= before.papers)
  }
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
