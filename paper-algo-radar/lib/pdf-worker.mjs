/**
 * PDF 解析子进程（FR-10.8：独立子进程 + 超时强杀）。
 *
 * 用法：node lib/pdf-worker.mjs <pdf 路径>
 * 输出：stdout 一行 JSON { ok, text, streams, decoded, diagnostics } 或 { ok:false, error }
 *
 * 单独成文件是为了能被 `child_process.spawn` 直接跑起来；
 * 不 import 插件其余部分，避免把 Cordis 上下文带进子进程。
 */
import { readFile } from 'node:fs/promises'
import { extractPdfText } from './pdf.js'

const path = process.argv[2]
try {
  if (!path) throw new Error('缺少 PDF 路径')
  const buffer = await readFile(path)
  const result = extractPdfText(buffer)
  process.stdout.write(JSON.stringify({ ok: true, ...result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
}
