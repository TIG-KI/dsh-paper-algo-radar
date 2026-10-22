/**
 * 错误词汇表（§10.3）。
 *
 * 工具与路由共用同一套 code；`message` 是给人读的中文，**不含正文、不含堆栈**。
 * 工具失败时抛出 `RadarError`，宿主会把 message 交给模型；
 * 路由失败时用 `toErrorPayload()` 转成 `{ ok:false, error:{ code, message, field? } }`。
 *
 * @module paper-algo-radar/errors
 */

export const ERROR_CODES = Object.freeze({
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  CAPABILITY_OFF: 'CAPABILITY_OFF',
  APPROVAL_UNAVAILABLE: 'APPROVAL_UNAVAILABLE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  EXTRACT_FAILED: 'EXTRACT_FAILED',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  CORRUPTED_STORE: 'CORRUPTED_STORE',
  ENGINE_MISMATCH: 'ENGINE_MISMATCH',
  INTERNAL: 'INTERNAL',
})

/** HTTP 状态映射：只有路由层用得到。 */
export const ERROR_HTTP_STATUS = Object.freeze({
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CAPABILITY_OFF: 403,
  APPROVAL_UNAVAILABLE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  EXTRACT_FAILED: 422,
  UPSTREAM_FAILED: 502,
  CORRUPTED_STORE: 500,
  ENGINE_MISMATCH: 500,
  INTERNAL: 500,
})

export class RadarError extends Error {
  /**
   * @param {string} code 见 ERROR_CODES
   * @param {string} message 给人读的中文说明（不得包含正文）
   * @param {{ field?: string, details?: object }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RadarError'
    this.code = ERROR_CODES[code] !== undefined ? code : ERROR_CODES.INTERNAL
    if (extra.field !== undefined) this.field = extra.field
    if (extra.details !== undefined) this.details = extra.details
  }
}

/** 把任意异常收敛成 `{ code, message, field? }`；未知异常一律 INTERNAL。 */
export function toErrorPayload(error) {
  if (error instanceof RadarError) {
    const payload = { code: error.code, message: error.message }
    if (error.field !== undefined) payload.field = error.field
    if (error.details !== undefined) payload.details = error.details
    return payload
  }
  if (error instanceof Error) {
    return { code: ERROR_CODES.INTERNAL, message: error.message }
  }
  return { code: ERROR_CODES.INTERNAL, message: String(error) }
}

/** 路由层用：带 HTTP 状态码。 */
export function toHttpError(error) {
  const payload = toErrorPayload(error)
  return { status: ERROR_HTTP_STATUS[payload.code] ?? 500, payload }
}
