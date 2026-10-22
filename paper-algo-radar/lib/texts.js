/**
 * 正文留存（§8 R11 / FR-7.7）。
 *
 * 规则：
 *  - **存**规范化正文（R1 之后、R3/R4 之前），gzip 落盘；**不存** PDF / HTML 原文。
 *  - 每篇一个文件：`<store 目录>/texts/<paperId>.txt.gz`。
 *  - 正文**不进日志、不进错误响应、不进工具返回、不进上下文**；唯一出口是 `includeText=1` 导出与重算。
 *  - 删除论文时同事务删正文；重算只从这份正文读。
 *
 * @module paper-algo-radar/texts
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** 单篇压缩前上限（§8 R11.4）：5,000,000 code point。 */
export const MAX_TEXT_CODE_POINTS = 5000000

export function textsDir(storeFile) {
  return join(dirname(storeFile), 'texts')
}

export function textPath(storeFile, paperId) {
  return join(textsDir(storeFile), `${paperId}.txt.gz`)
}

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * 写入一篇正文。
 * @returns {{ sha1: string, rawChars: number, bytes: number, textHash: string }}
 */
export async function writeText(storeFile, paperId, text) {
  const body = String(text ?? '')
  // rawChars 按 code point 计（§8 G-4）
  let rawChars = 0
  for (const _ of body) rawChars += 1
  if (rawChars > MAX_TEXT_CODE_POINTS) {
    throw new Error(`正文过长（${rawChars} code point > ${MAX_TEXT_CODE_POINTS}）`)
  }
  const compressed = await gzipAsync(Buffer.from(body, 'utf8'))
  const target = textPath(storeFile, paperId)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, compressed)
  const digest = sha1(body)
  return { sha1: digest, rawChars, bytes: compressed.length, textHash: digest.slice(0, 16) }
}

/** 读回一篇正文；没有留存返回 null（调用方据此判断「不可重算」）。 */
export async function readText(storeFile, paperId) {
  try {
    const compressed = await readFile(textPath(storeFile, paperId))
    return (await gunzipAsync(compressed)).toString('utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** 删除一篇正文；不存在也算成功。 */
export async function removeText(storeFile, paperId) {
  try {
    await rm(textPath(storeFile, paperId), { force: true })
    return true
  } catch {
    return false
  }
}
