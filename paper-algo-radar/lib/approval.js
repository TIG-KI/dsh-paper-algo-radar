/**
 * 写审批闸门（§8 FR-8.5 / 8.6）。
 *
 * 结算表（与 `dsh-user-approval` 的语义一致，**失败一律关闭**）：
 *  - `allowed-once`            → `allowed`
 *  - `rejected` / `cancelled`  → `declined`
 *  - `unavailable` / 异常 / 无 agent / 无审批服务 → `unavailable`（失败关闭）
 *
 * 注意：本会话的策略是 `never`（审批提示被禁用），此时 `request()` 会直接拒绝，
 * 所以破坏性操作在无审批通道的环境里**不可能通过**——这正是设计意图，不是 bug。
 *
 * @module paper-algo-radar/approval
 */

export const WRITE_APPROVAL_REASON = '这次操作会整体替换或清空算法库内容，需要你确认。'

/**
 * @param {object} ctx Cordis 上下文（只用到 `ctx.get('approval')`）
 * @param {{ agent?: object, name?: string, callId?: string, signal?: object }} exec 工具执行上下文
 * @param {string} [reason]
 * @returns {Promise<'allowed'|'declined'|'unavailable'>}
 */
export async function requestWriteApproval(ctx, exec, reason = WRITE_APPROVAL_REASON) {
  const get = ctx?.get
  if (typeof get !== 'function') return 'unavailable'
  const approval = get.call(ctx, 'approval')
  // 没有审批服务：决定无法路由、无法审计 → 失败关闭
  if (approval === undefined || approval === null || typeof approval.request !== 'function') return 'unavailable'
  // 没有 agent：无法路由到会话、无法写审计对 → 失败关闭
  if (exec?.agent === undefined || exec?.agent === null) return 'unavailable'

  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      displayReason: {
        en: 'Allow this algorithm-radar write? It replaces or clears library content.',
        zh: '允许这次算法库写入？它会替换或清空库内容。',
      },
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    })
  } catch {
    // 会话外、审计写失败、answerer 抛错：无法记录决定 → 不允许写
    return 'unavailable'
  }

  if (outcome === 'allowed-once') return 'allowed'
  if (outcome === 'rejected' || outcome === 'cancelled') return 'declined'
  return 'unavailable'
}

/** 把审批结论翻译成给模型看的一句话。 */
export function describeApprovalVerdict(verdict) {
  if (verdict === 'declined') return '用户拒绝了这次写入，库没有任何改动。不要未经允许重试。'
  if (verdict === 'unavailable') {
    return '审批通道不可用（本会话可能禁用了审批提示），这次写入被拒绝。库没有任何改动。'
  }
  return '已获批准。'
}
