/**
 * 每日自动备份（§7 FR-7.6）。
 *
 * 规则：
 *  - 每天最多一份：`<数据目录>/backups/radar-YYYYMMDD.json`
 *  - 保留最近 ≥7 份，更老的删掉
 *  - **不起定时器**：在「有写入」或「读状态」时顺带检查，当天已备份就直接返回
 *  - 备份内容是结构化快照；正文文件在 `texts/` 下，**备份不打包正文**（要迁移请连 `texts/` 一起拷）
 *
 * @module paper-algo-radar/backup
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BACKUP_KEEP = 7

function stampOf(now) {
  const date = new Date(now)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

export function backupDir(storeFile) {
  return join(dirname(storeFile), 'backups')
}

/**
 * 当天没备份就写一份，并清掉超期的。
 * @returns {Promise<{created: boolean, file: string|null, kept: number, pruned: number}>}
 */
export async function maybeDailyBackup(store, options = {}) {
  const keep = Number(options.keep) > 0 ? Number(options.keep) : BACKUP_KEEP
  const now = typeof options.now === 'function' ? options.now() : Date.now()
  const stamp = stampOf(now)
  const dir = backupDir(store.file)
  const target = join(dir, `radar-${stamp}.json`)

  await mkdir(dir, { recursive: true })
  const files = (await readdir(dir)).filter((name) => /^radar-\d{8}\.json$/.test(name)).sort()

  if (files.includes(`radar-${stamp}.json`)) {
    return { created: false, file: target, kept: files.length, pruned: 0 }
  }

  // 备份内容：结构化快照（不含正文）
  const payload = {
    schemaVersion: options.schemaVersion ?? null,
    dictVersion: options.dictVersion ?? null,
    backedUpAt: new Date(now).toISOString(),
    papers: [...store.papers.values()],
    algorithms: [...store.algorithms.values()],
    mentions: [...store.mentions.values()],
    paperKeys: [...store.paperKeys.entries()].map(([key, paperId]) => ({ key, paperId })),
    meta: [...store.meta.values()],
  }
  await writeFile(target, JSON.stringify(payload, null, 2), 'utf8')

  const after = [...files, `radar-${stamp}.json`].sort()
  const excess = after.slice(0, Math.max(0, after.length - keep))
  let pruned = 0
  for (const name of excess) {
    await rm(join(dir, name), { force: true })
    pruned += 1
  }

  return { created: true, file: target, kept: after.length - pruned, pruned }
}

/** 只读：当前备份状况（给状态与设置页展示）。 */
export async function backupStatus(store) {
  const dir = backupDir(store.file)
  try {
    const files = (await readdir(dir)).filter((name) => /^radar-\d{8}\.json$/.test(name)).sort()
    return {
      dir,
      count: files.length,
      latest: files.length > 0 ? files[files.length - 1] : null,
      keep: BACKUP_KEEP,
    }
  } catch {
    return { dir, count: 0, latest: null, keep: BACKUP_KEEP }
  }
}
