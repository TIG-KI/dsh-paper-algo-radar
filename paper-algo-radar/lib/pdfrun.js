/**
 * PDF 解析的子进程封装（§7 FR-10.8）。
 *
 * 为什么放子进程：解析是不可信输入，超时能强杀、崩溃不带走宿主。
 * 为什么可注入：测试用 `setPdfRunner` 直接给假实现（含超时场景），不必真的 spawn。
 *
 * @module paper-algo-radar/pdfrun
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url))

let runner = null

/** 测试用：替换解析实现；传 null 恢复子进程。 */
export function setPdfRunner(fn) {
  runner = fn
}

/**
 * @param {string} pdfPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ text: string, streams: number, decoded: number, diagnostics: string[] }>}
 */
export async function extractPdfInWorker(pdfPath, options = {}) {
  if (runner !== null) return runner(pdfPath, options)

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const child = spawn(process.execPath, [WORKER, pdfPath], {
      // Electron 宿主里 process.execPath 是 app 可执行文件，需要这个开关当 node 用
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经退出
      }
      finish(reject, Object.assign(new Error(`PDF 解析超时（${timeoutMs}ms）`), { code: 'PDF_TIMEOUT' }))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish(reject, Object.assign(error, { code: 'PDF_SPAWN_FAILED' }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed = null
      try {
        parsed = JSON.parse(stdout)
      } catch {
        finish(
          reject,
          Object.assign(new Error(`PDF 子进程输出无法解析（exit ${code}）：${stderr.slice(0, 200)}`), {
            code: 'PDF_PARSE_FAILED',
          }),
        )
        return
      }
      if (parsed.ok === true) finish(resolve, parsed)
      else finish(reject, Object.assign(new Error(String(parsed.error ?? 'PDF 解析失败')), { code: 'PDF_PARSE_FAILED' }))
    })
  })
}
