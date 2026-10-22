#!/usr/bin/env node
/**
 * 修复「乱码正文」：把历史上以字形码 / 二进制形式入库的正文清掉。
 *
 * 背景：旧版 PDF 抽取（lib/pdf.js）会把 CID/Type0 字体与二进制流当成正文，
 * 产出「字符很多、没有一个词」的文本；这些文本已不可恢复（PDF 原件按设计不留），
 * 只能清掉，同时清掉由它派生的提及（排行、片段都来自提及）。
 *
 * 用法：
 *   node scripts/repair-corrupt-texts.mjs                 # 只体检（默认，不写任何东西）
 *   node scripts/repair-corrupt-texts.mjs --apply         # 真清理（先备份 store.json）
 *   node scripts/repair-corrupt-texts.mjs --apply --mode delete-papers
 *
 * 选项：
 *   --store <path>   store.json 路径，默认 ~/.dsh/plugin-data/paper-algo-radar/store.json
 *   --mode <mode>    purge-text（默认）：保留论文记录，只清正文 + 派生提及
 *                    delete-papers：连论文记录一起删
 *
 * 注意：**先退出宿主再 --apply**。宿主把算法库常驻内存，边跑边改会被它写回旧值。
 */
import { copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { analyzeText } from '../lib/textquality.js'
import { readText, removeText } from '../lib/texts.js'

const { __test } = await import('../lib/index.js')
const { Store } = __test

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const defaultStore = join(homedir(), '.dsh', 'plugin-data', 'paper-algo-radar', 'store.json')
const storeFile = value('--store', defaultStore)
const apply = flag('--apply')
const mode = value('--mode', 'purge-text')
if (!['purge-text', 'delete-papers'].includes(mode)) {
  console.error(`未知 --mode：${mode}（可选 purge-text / delete-papers）`)
  process.exit(2)
}

const store = new Store(storeFile)
const loaded = await store.load()
if (!loaded) {
  console.error(`没有找到算法库：${storeFile}`)
  process.exit(2)
}

const bad = []
const missing = []
for (const paper of store.papers.values()) {
  const text = await readText(storeFile, paper.id)
  if (text === null) {
    missing.push(paper)
    continue
  }
  const quality = analyzeText(text)
  if (quality.usable) continue
  const mentions = [...store.mentions.values()].filter((m) => m.paperId === paper.id).length
  bad.push({ paper, quality, mentions, chars: quality.chars })
}

console.log(`算法库：${storeFile}`)
console.log(`论文 ${store.papers.size} 篇 / 提及 ${store.mentions.size} 条 / 有正文 ${store.papers.size - missing.length} 篇`)
console.log(`\n判定为乱码正文：${bad.length} 篇（影响 ${bad.reduce((s, item) => s + item.mentions, 0)} 条提及）\n`)
if (bad.length > 0) {
  console.log('坏度 | 标题 | 字符 | 提及 | 理由')
  const sorted = [...bad].sort((a, b) => b.quality.control - a.quality.control)
  for (const item of sorted) {
    console.log(
      [
        `${(item.quality.control * 100).toFixed(1)}%`,
        item.paper.title.slice(0, 30),
        item.chars,
        item.mentions,
        item.quality.reasons.join('；').slice(0, 60),
      ].join(' | '),
    )
  }
}
if (missing.length > 0) {
  console.log(`\n另有 ${missing.length} 篇没有正文文件（不参与判定，保持原样）。`)
}

if (bad.length === 0) {
  console.log('\n没有需要清理的正文。')
  process.exit(0)
}
if (!apply) {
  console.log('\n（dry-run：没有改动任何东西。确认后加 --apply；建议先退出宿主。）')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupFile = `${storeFile}.pre-repair-${stamp}`
await copyFile(storeFile, backupFile)
console.log(`\n已备份：${backupFile}`)

const now = Date.now()
for (const { paper } of bad) {
  if (mode === 'delete-papers') {
    store.papers.delete(paper.id)
    for (const [key, owner] of [...store.paperKeys.entries()]) {
      if (owner === paper.id) store.paperKeys.delete(key)
    }
  } else {
    store.papers.set(paper.id, {
      ...paper,
      hasText: false,
      chars: 0,
      hitCount: 0,
      rawChars: 0,
      textHash: '',
      updatedAt: now,
    })
  }
  for (const key of [...store.mentions.keys()]) {
    if (key.startsWith(`${paper.id}::`)) store.mentions.delete(key)
  }
  await removeText(storeFile, paper.id)
}

// 没有提及的算法条目不会被自动回收，这里顺手清掉，否则排行里会留下空算法
for (const [algorithmId, entry] of [...store.algorithms.entries()]) {
  const stillUsed = [...store.mentions.values()].some((m) => m.algorithmId === algorithmId)
  if (!stillUsed) store.algorithms.delete(algorithmId)
}

await store.save()
console.log(
  `\n完成：${mode === 'delete-papers' ? '删除' : '清空'} ${bad.length} 篇；` +
    `现在 论文 ${store.papers.size} 篇 / 提及 ${store.mentions.size} 条 / 算法 ${store.algorithms.size} 个。`,
)
console.log(
  '重启宿主后生效。备份只含 store.json：回滚能恢复论文记录与提及数，' +
    '但已删的乱码正文不会回来（那正是这次清理的对象）。',
)
