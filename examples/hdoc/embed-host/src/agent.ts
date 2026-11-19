import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type Grant = {
  endpoint: string
  token: string
  documentId: string
  expiresAt: number
}
export type SelectionRead = {
  file: string
  revision: number
  documentId: string
  kind: 'document' | 'canvas' | 'spec'
  spans?: { text: string }[]
  elements?: { id: string; type: string; text?: string }[]
}
export type SpecUndo = {id:string; revision:number; epoch:number}
type Receipt = { specUndo?:SpecUndo; revision: number; documentId: string; changed: number }

type ToolCall = <T>(name: string, args?: Record<string, unknown>) => Promise<T>
export type PlannedAction = {
  fileId: string
  tool: string
  args: Record<string, unknown>
}
async function withAgent<T>(grant: Grant, run: (call: ToolCall) => Promise<T>) {
  // The host proxies this path to its configured Workspace. External processes
  // instead use grant.endpoint directly, with the same limited bearer.
  const client = new Client({ name: 'fold-project-agent', title: '墨点', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL('/workspace/mcp/selection', location.origin),
    {
      requestInit: {
        headers: { Authorization: 'Bearer ' + grant.token },
        credentials: 'omit',
      },
    },
  )
  async function call<T>(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args })
    const part = Array.isArray(result.content) ? result.content[0] : null
    if (result.isError || !part || part.type !== 'text')
      throw new Error(part?.text || 'MCP 调用失败。')
    return JSON.parse(part.text) as T
  }
  try {
    await client.connect(transport)
    return await run(call)
  } finally {
    await client.close()
  }
}

export function applyAgentAction(
  grant: Grant,
  action: PlannedAction,
  requestId: string,
) {
  return withAgent(grant, async (call) => {
    const receipt = await call<Receipt>(action.tool, {
      ...action.args,
      requestId,
    })
    if (receipt.documentId !== grant.documentId)
      throw new Error('文件回执与本次授权不匹配。')
    return receipt
  })
}

export async function runAgent(
  grant: Grant,
  action: 'read' | 'replace' | 'color' | 'move',
  value = '',
) {
  return withAgent(grant, async (call) => {
    const selection = await call<SelectionRead>('read_selection')
    if (selection.documentId !== grant.documentId)
      throw new Error('当前文件已经切换。')
    if (action === 'read') return { selection }
    const requestId = crypto.randomUUID()
    let receipt: Receipt
    if (selection.kind === 'document' || selection.kind === 'spec') {
      if (action !== 'replace') throw new Error('请选择正文替换操作。')
      const spans = selection.spans || []
      const replacements = spans.length === 1 ? [value] : value.split('\n')
      if (replacements.length !== spans.length)
        throw new Error('请每个选中段落输入一行替换文字。')
      receipt = await call<Receipt>('replace_selected_text', {
        requestId,
        replacements,
      })
    } else {
      const edits = (selection.elements || [])
        .filter((e) => action !== 'replace' || e.type === 'text')
        .map((e) => ({
          id: e.id,
          ...(action === 'move'
            ? { dx: 24, dy: 0 }
            : action === 'color'
              ? { strokeColor: value }
              : { text: value }),
        }))
      if (!edits.length) throw new Error('请选择白板上的文字对象。')
      receipt = await call<Receipt>('edit_canvas_selection', {
        requestId,
        edits,
      })
    }
    return { selection, receipt }
  })
}
