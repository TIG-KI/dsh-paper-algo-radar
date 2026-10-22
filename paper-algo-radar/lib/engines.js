/**
 * FR-10.2 · 引擎兼容性（engines.dsh / engines.node）。
 *
 * 分工要说清楚，避免重复实现：
 *
 *  - **engines.dsh**：由宿主加载器在 `import` 插件之前校验。
 *    DSH 用 `getDshRuntimeVersion()` 取运行时版本，再按插件的 `engines.dsh`
 *    （没有才看 `@deepseek-ai/dsh*` 的 peerDependencies）判断；不满足的 bundle
 *    会被跳过并列入 `skippedBundles`，插件模块根本不会被导入。
 *    所以本模块**不再自己发现宿主版本**——如果 `apply()` 真的跑到了，ds 版本
 *    已经通过了；再写一遍只会得到一段永远走不到、还可能因探测失败误报的死代码。
 *
 *  - **engines.node**：宿主不负责。Node 版本不满足时 npm 默认只警告不拦截，
 *    插件会半加载。这里在 `apply()` 的第一行做纯函数比较，失败就抛
 *    `ENGINE_MISMATCH`，不注册任何工具 / 路由 / 提示段，也不碰数据。
 *
 * 声明常量必须与 package.json 保持一致；`test/engines.test.mjs` 会断言两者相等，
 * 防止只改一边。
 *
 * @module paper-algo-radar/engines
 */
import { RadarError } from './errors.js'

/** 与 package.json 的 `engines.dsh` 一致；实际校验由宿主加载器完成。 */
export const REQUIRED_DSH_RANGE = '>=0.2.1-rc.2'

/** 与 package.json 的 `engines.node` 一致；由本模块在激活时校验。 */
export const REQUIRED_NODE_RANGE = '>=22.19.0'

/** 宿主校验 dsh 的方式（写进 /state，方便排查）。 */
export const DSH_ENFORCED_BY = 'host-loader'

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 解析 `major.minor.patch[-prerelease][+build]`。
 * @param {unknown} value
 * @returns {{nums: [number, number, number], pre: string[]} | null}
 */
export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value ?? '').trim())
  if (match === null) return null
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareParsed(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.nums[index] !== b.nums[index]) return a.nums[index] < b.nums[index] ? -1 : 1
  }
  // 预发布版低于同版本正式版：22.19.0-rc.1 < 22.19.0
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const l = Number(left)
      const r = Number(right)
      if (l !== r) return l < r ? -1 : 1
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/**
 * 语义化比较；任一侧无法解析时返回 null（调用方必须按「不满足」处理，失败关闭）。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number | null}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  return compareParsed(a, b)
}

/**
 * 校验 Node 版本是否满足声明（当前只支持 `>=x.y.z` 一种形式）。
 * @param {string} [runtime]
 * @param {string} [range]
 * @returns {{ok: boolean, declared: string, required: string, runtime: string, message: string}}
 */
export function checkNodeEngine(runtime = process.versions.node, range = REQUIRED_NODE_RANGE) {
  const declared = String(range ?? '')
  const required = declared.replace(/^>=/, '').trim()
  const currentText = String(runtime ?? '')
  const base = { declared, required, runtime: currentText }

  if (!declared.startsWith('>=') || required === '') {
    return {
      ...base,
      ok: false,
      message: `论文算法雷达的 Node 版本声明「${declared}」无法识别；为避免半加载，插件不会激活。`,
    }
  }

  const current = parseVersion(currentText)
  const floor = parseVersion(required)
  if (current === null || floor === null) {
    return {
      ...base,
      ok: false,
      message:
        `无法识别当前 Node 版本「${currentText}」或要求「${required}」。` +
        `论文算法雷达要求 Node ${declared}；为避免半加载，插件不会激活（不注册工具、不读写数据）。`,
    }
  }

  if (compareParsed(current, floor) >= 0) return { ...base, ok: true, message: '' }
  return {
    ...base,
    ok: false,
    message:
      `论文算法雷达需要 Node ${declared}，当前运行 ${currentText}。` +
      `插件不会激活（不注册工具、不读写数据）；请升级 Node 后重启宿主。`,
  }
}

/**
 * `apply()` 的第一道闸：不满足就抛 `ENGINE_MISMATCH`。
 * @param {string} [runtime]
 * @param {ReturnType<typeof checkNodeEngine>} [check]
 */
export function assertNodeEngine(runtime = process.versions.node, check = checkNodeEngine(runtime)) {
  if (!check.ok) {
    throw new RadarError('ENGINE_MISMATCH', check.message, {
      field: 'engines.node',
      details: { required: check.required, runtime: check.runtime },
    })
  }
  return check
}

/**
 * 暴露到 `/state.engines` 的诊断快照。
 * @param {string} [runtime]
 */
export function engineStateOf(runtime = process.versions.node) {
  return {
    dsh: { declared: REQUIRED_DSH_RANGE, enforcedBy: DSH_ENFORCED_BY },
    node: checkNodeEngine(runtime),
  }
}
