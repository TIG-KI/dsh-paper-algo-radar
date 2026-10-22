/**
 * 最小 CDP 驱动：连到无头 Chrome，执行一段 JS，可选截图。
 *
 * 用法：node cdp.mjs <debugPort> <urlSubstring> <jsFile|jsExpression>
 *   CDP_SHOT=<png 路径>  额外截一张图
 *
 * 输出：JS 表达式的返回值（JSON）。表达式里用 IIFE + await 即可。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const [port, urlSubstring, exprArg] = process.argv.slice(2)
const shotPath = process.env.CDP_SHOT

const expr = existsSync(exprArg) ? readFileSync(exprArg, 'utf8') : exprArg

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const target = targets.find((t) => t.type === 'page' && String(t.url).includes(urlSubstring ?? ''))
if (target === undefined) {
  console.error('[cdp] 没找到目标页面，现有：', targets.map((t) => `${t.type} ${t.url}`).join(' / '))
  process.exit(1)
}
console.log('[cdp] target:', target.url)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

await send('Runtime.enable')
await send('Page.enable')

const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
})

if (result.exceptionDetails) {
  console.log(JSON.stringify({ error: result.exceptionDetails.text, detail: result.result?.description }, null, 2))
} else {
  console.log(JSON.stringify(result.result?.value, null, 2))
}

if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('[shot]', shotPath)
}

ws.close()
process.exit(0)
