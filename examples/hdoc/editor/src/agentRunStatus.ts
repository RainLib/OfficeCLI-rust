export type AgentToolEvent = {
  type: string; name?: string; agentId?: string; ok?: boolean; status?: number; error?: string
}

export function toolIssueLabel(event: AgentToolEvent): string {
  if (event.status === 409 || event.status === 412) {
    return event.error?.includes('unsaved edits') ? '等待未保存内容' : '文档版本已更新'
  }
  if (event.status === 403) return event.error?.includes('认领') ? '超出分工范围' : '访问权限不足'
  if (event.status === 400 || event.status === 422) return '操作参数需要调整'
  return '操作暂未完成'
}

/** A peer's successful write must never hide this member's failed write. */
export function agentRunNotice(run: { status: string; events: AgentToolEvent[] }) {
  // Recovery reports its interruption and preserved receipts in the task
  // result. An old tool conflict is not the current execution state.
  if (run.status === 'interrupted') return null
  const pending = new Map<string, AgentToolEvent>()
  let hadError = false, continued = false
  for (const event of run.events) {
    if (event.type === 'continuation_authorized') { pending.clear(); hadError = false; continued = true; continue }
    if (event.type !== 'tool_result') continue
    const actor = event.agentId || 'legacy'
    const key = `${actor}:${event.name}`
    if (event.ok === false) { pending.set(key, event); hadError = true }
    if (event.ok) {
      pending.delete(key)
      if (event.name === 'hcd_patch') {
        for (const [key, failed] of pending) {
          if ((failed.agentId || 'legacy') === actor) pending.delete(key)
        }
      }
    }
  }
  const running = ['running', 'cancelling'].includes(run.status)
  if (!hadError) return continued && (running || run.status === 'completed') ? { recovered: true, text: running ? '已获授权，正在继续剩余工作。' : '已按核对结果完成剩余工作。' } : null
  const unresolved = [...pending.values()]
  const mutations = unresolved.filter(event => ['hcd_patch', 'hcd_project'].includes(event.name || ''))
  if (!unresolved.length) return { recovered: true, text: continued ? (running ? '已获授权，正在继续剩余工作。' : run.status === 'completed' ? '已按核对结果完成剩余工作。' : '已恢复部分操作，请查看任务结果。') : running ? '已自动恢复，继续执行。' : run.status === 'completed' ? '已自动恢复并完成任务。' : '已恢复部分操作，请查看任务结果。' }
  if (!mutations.length && run.status === 'completed') return { recovered: true, text: '文档修改已完成，部分辅助操作未执行。' }
  const failed = mutations.at(-1) || unresolved.at(-1)!
  const issue = toolIssueLabel(failed)
  const text = issue === '文档版本已更新' ? (running ? '其他协作者已更新文档，正在同步并重新计算。' : '部分修改仍有版本冲突，尚未提交。')
    : issue === '等待未保存内容' ? (running ? '正在等待编辑中的内容保存。' : '有未保存内容，部分修改未提交。')
    : issue === '操作参数需要调整' ? (running ? 'Agent 正在修正操作参数。' : '部分操作参数错误，未能执行。')
    : issue === '超出分工范围' ? '操作超出当前 Agent 的分工范围。'
    : issue === '访问权限不足' ? '当前 Agent 缺少所需的编辑权限。'
    : '部分操作未完成，请查看操作记录。'
  return { recovered: false, text }
}
