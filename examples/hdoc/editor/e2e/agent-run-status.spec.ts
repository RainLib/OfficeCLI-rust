import { test, expect } from '@playwright/test'
import { agentRunNotice, toolIssueLabel, type AgentToolEvent } from '../src/agentRunStatus.ts'

const event = (agentId: string, name: string, ok: boolean, status?: number, error?: string): AgentToolEvent => ({ type: 'tool_result', agentId, name, ok, status, error })

test('a peer commit cannot hide another members unresolved conflict', () => {
  const events = [event('a', 'hcd_patch', false, 409), event('b', 'hcd_patch', true)]
  expect(agentRunNotice({ status: 'running', events })).toEqual({ recovered: false, text: '其他协作者已更新文档，正在同步并重新计算。' })
  expect(agentRunNotice({ status: 'failed', events })?.text).toContain('尚未提交')
  expect(agentRunNotice({ status: 'completed', events: [...events, event('a', 'hcd_patch', true)] })).toEqual({ recovered: true, text: '已自动恢复并完成任务。' })
})

test('fresh reads alone do not mean a failed mutation has recovered', () => {
  expect(agentRunNotice({ status: 'running', events: [event('a', 'hcd_patch', false, 409), event('a', 'hcd_read', true)] })?.recovered).toBe(false)
})

test('a restored interrupted task does not present an old conflict as its current failure', () => {
  expect(agentRunNotice({ status: 'interrupted', events: [event('a', 'hcd_patch', false, 409)] })).toBeNull()
})

test('focus parameter errors remain distinct from an incomplete document change', () => {
  const events = [event('a', 'hcd_patch', true), event('a', 'hcd_activity', false, 400)]
  expect(agentRunNotice({ status: 'completed', events })?.text).toBe('文档修改已完成，部分辅助操作未执行。')
  expect(toolIssueLabel(events[1])).toBe('操作参数需要调整')
})

test('permission, ownership and pending human edits have separate explanations', () => {
  expect(toolIssueLabel(event('a', 'hcd_patch', false, 403, '写入超出此 Agent 认领的范围'))).toBe('超出分工范围')
  expect(toolIssueLabel(event('a', 'hcd_patch', false, 403, 'read only'))).toBe('访问权限不足')
  expect(agentRunNotice({ status: 'running', events: [event('a', 'hcd_patch', false, 409, 'collaborators have unsaved edits')] })?.text).toBe('正在等待编辑中的内容保存。')
})

test('authorized continuation summarizes the current attempt without relabeling it as automatic recovery', () => {
  const events = [event('a', 'hcd_patch', false, 409), { type: 'continuation_authorized' }, event('a', 'hcd_read', true)]
  expect(agentRunNotice({ status: 'running', events })?.text).toBe('已获授权，正在继续剩余工作。')
  expect(agentRunNotice({ status: 'completed', events })?.text).toBe('已按核对结果完成剩余工作。')
  expect(agentRunNotice({ status: 'failed', events })).toBeNull()
  expect(agentRunNotice({ status: 'running', events: [...events, event('a', 'hcd_patch', false, 403, '认领范围')] })?.text).toContain('分工范围')
})
