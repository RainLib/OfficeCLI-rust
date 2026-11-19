import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EmbeddedHcdEditor } from '@officecli/hcd-reference-editor/react'
import '@officecli/hcd-reference-editor/style.css'
import { runAgent } from './agent'
import { ManualHost } from './ManualHost'
import './style.css'

import { api, mutation, query, type Account, type FileEntry } from './hostApi'
import { useFileBinding } from './useFileBinding'
import { OfficeDesk } from './OfficeDesk'
function Mark({ board = false }: { board?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      width="25"
      height="25"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      {board ? (
        <>
          <rect x="3.5" y="5" width="25" height="19.5" rx="4" />
          <path d="m9 28 3-3m11 3-3-3M9 11h6v5H9zm10 3h4v4h-4z" />
        </>
      ) : (
        <>
          <path d="M7 3.5h13l5 5V27a1.5 1.5 0 0 1-1.5 1.5H7A2 2 0 0 1 5 26.5v-21a2 2 0 0 1 2-2Z" />
          <path d="M19 4v6h6M10 15h10m-10 5h7" />
        </>
      )}
    </svg>
  )
}
function AccountGate({
  children,
}: {
  children: (a: Account) => React.ReactNode
}) {
  const [account, setAccount] = useState<Account | null>(null),
    [pending, setPending] = useState(true),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api<Account>('/session')
      .then((a) => {
        if (active) setAccount(a)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPending(false)
      })
    return () => {
      active = false
    }
  }, [])
  if (account) return <>{children(account)}</>
  if (pending)
    return (
      <main className="embed-wait" role="status">
        正在打开业务工作台…
      </main>
    )
  return (
    <main className="example-login">
      <strong>折页 · 项目工作台</strong>
      <h1>登录业务工作区</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          try {
            setAccount(
              await api<Account>(
                '/login',
                mutation('', {
                  username: data.get('username'),
                  password: data.get('password'),
                }),
              ),
            )
          } catch (c) {
            setError(String(c))
          }
        }}
      >
        <label>
          账号
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button>登录</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <a href="?manual=1">使用已有文档 ID 和短期令牌</a>
    </main>
  )
}

function Project({ account }: { account: Account }) {
  const [kind, setKind] = useState(
      query.get('view') === 'board' ? 'board' : 'document',
    ),
    [files, setFiles] = useState<FileEntry[]>([]),
    [ready, setReady] = useState(false),
    [error, setError] = useState('')
  const [chosen, choose] = useState(query.get('file') || '')
  const standalone = query.get('standalone') === '1'
  useEffect(() => {
    let active = true
    void api<{ files: FileEntry[] }>('/files')
      .then((r) => {
        if (active) setFiles(r.files)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
      .finally(() => {
        if (active) setReady(true)
      })
    return () => {
      active = false
    }
  }, [account])
  const matches = files.filter((f) =>
    kind === 'board'
      ? f.format === 'excalidraw'
      : ['docx', 'txt', 'md', 'html'].includes(f.format),
  )
  const file = chosen ? matches.find((f) => f.id === chosen) : matches[0]
  const [chat, setChat] = useState(false)
  function switchFile(view: string, id = '') {
    setKind(view)
    choose(id)
    const url = new URL(location.href)
    if(url.searchParams.get('file')!==id)url.searchParams.delete('node-id')
    url.searchParams.set('view', view)
    if (id) url.searchParams.set('file', id)
    else url.searchParams.delete('file')
    history.replaceState(null, '', url)
  }
  return (
    <main className="embed-project">
      <header className="project-top">
        <div className="project-brand">
          <span className="fold-mark" aria-hidden="true">
            ◩
          </span>
          <strong>折页</strong>
          <i />
          项目工作台
        </div>
        {!standalone && (
          <nav aria-label="嵌入视图">
            {[
              ['document', '文档'],
              ['board', '白板'],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={kind === id}
                onClick={() => switchFile(id)}
              >
                <Mark board={id === 'board'} />
                {label}
              </button>
            ))}
          </nav>
        )}
        <button
          className="chat-toggle"
          aria-pressed={chat}
          onClick={() => setChat(!chat)}
        >
          <span aria-hidden="true">✦</span> AI 聊天
        </button>
      </header>
      <div className="project-title">
        <div className="file-heading">
          <span className={'file-art ' + kind}>
            <Mark board={kind === 'board'} />
          </span>
          <div>
            <small>
              项目文件 / {kind === 'board' ? '协作白板' : '内容文档'}
            </small>
            <h1>{file?.name || (kind === 'board' ? '白板' : '文档')}</h1>
          </div>
        </div>
        {!standalone && matches.length > 1 && (
          <label>
            切换文件{' '}
            <select
              value={file?.id}
              onChange={(e) => switchFile(kind, e.target.value)}
            >
              {matches.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!standalone && file && (
          <a
            className="standalone-link"
            href={
              '?' +
              new URLSearchParams({
                view: kind,
                file: file.id,
                standalone: '1',
              })
            }
          >
            单独打开 <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : file ? (
        <FileHost key={file.id} file={file} account={account} chat={chat} openChat={()=>setChat(true)} />
      ) : (
        <p className="embed-wait">
          {!ready
            ? '正在读取文件…'
            : chosen
              ? '找不到此文件，或当前账号没有访问权限。'
              : '此账号还没有该类型的文件。'}
        </p>
      )}
    </main>
  )
}

function FileHost({
  file,
  account,
  chat, openChat,
}: {
  file: FileEntry
  account: Account
  chat: boolean
  openChat:()=>void
}) {
  const {
    launch,
    selection,
    report,
    grant,
    connect,
    clear,
    error,
    setError,
    notice,
    setNotice,
    alive,
  } = useFileBinding(file, account)
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState(''),
    [command, setCommand] = useState(''),
    [messages, setMessages] = useState<{ role: string; text: string }[]>([])
  const board = file.format === 'excalidraw',
    allowed = account.workspace.selectionMcp && file.canDelegateSelection
  async function execute(
    action: 'read' | 'replace' | 'color' | 'move' | 'connect',
    input = '',
    fromChat = false,
  ) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const scoped = await connect()
      if (action === 'connect') {
        setNotice(
          '已连接当前选区，授权至 ' +
            new Date(scoped.expiresAt * 1000).toLocaleTimeString('zh-CN') +
            '。',
        )
        return
      }
      const { selection: read, receipt } = await runAgent(scoped, action, input)
      const message = receipt
        ? '已保存到 r' +
          receipt.revision +
          '，修改了 ' +
          receipt.changed +
          ' 处。'
        : (
            read.spans?.map((s) => s.text) ||
            read.elements?.map((e) => e.text || e.type + ' · ' + e.id) ||
            []
          ).join('\n')
      if (alive.current) {
        setNotice(message)
        if (fromChat)
          setMessages((prev) => [...prev, { role: 'Agent', text: message }])
      }
    } catch (c) {
      if (alive.current) setError(c instanceof Error ? c.message : String(c))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  function send(text: string) {
    const line = text.trim()
    if (!line || busy) return
    setCommand('')
    setMessages((prev) => [...prev, { role: '你', text: line }])
    if (account.demoAgent) {
      setBusy(true)
      setError('')
      void connect()
        .then(async (scoped) => {
          const response = await fetch('/business/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: scoped.token, prompt: line }),
          })
          const answer = await response.json()
          if (!response.ok)
            throw new Error(answer.error || '外部 Agent 暂时不可用。')
          if (alive.current) {
            setMessages((prev) => [
              ...prev,
              { role: 'Agent', text: answer.reply },
            ])
            if (answer.receipt) setNotice(answer.reply)
          }
        })
        .catch((c) => {
          if (alive.current) setError(String(c))
        })
        .finally(() => {
          if (alive.current) setBusy(false)
        })
      return
    }
    const color = line.match(/#[a-f0-9]{6}/i)
    if (/^(?:替换为|改写为)[：:\s]*/.test(line))
      void execute('replace', line.replace(/^(?:替换为|改写为)[：:\s]*/, ''), true)
    else if (board && color) void execute('color', color[0], true)
    else if (board && line.includes('右移')) void execute('move', '', true)
    else if (/读|查看|选中了什么/.test(line)) void execute('read', '', true)
    else
      setMessages((prev) => [
        ...prev,
        {
          role: 'Agent',
          text: board
            ? '可以读取选区、右移，或输入颜色，例如 #84619b。'
            : '输入「读取选区」或「替换为」加上新的文字。',
        },
      ])
  }
  const help = board ? '点选或框选白板上的对象' : '在正文中拖选一段文字'
  const count =
    selection?.target.kind === 'canvas'
      ? selection.target.elementIds.length

      : selection?.target.kind === 'document'
        ? selection.target.spans.length
        : undefined
  const pane = (
    <div className="sample-chat">
      <header>
        <span aria-hidden="true">✦</span>
        <strong>选区助手</strong>
      </header>
      <small>{account.demoAgent?.model || '本地指令示例'} · MCP</small>
      <div className="chat-messages" aria-live="polite">
        {messages.length ? (
          messages.map((m, i) => (
            <p key={i}>
              <strong>{m.role}</strong>
              {m.text}
            </p>
          ))
        ) : (
          <p>{help}，再发送“读取选区”。</p>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          send(command)
        }}
      >
        <label htmlFor="agent-message">消息</label>
        <textarea
          id="agent-message"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={
            board ? '读取选区 / 右移 / 改为 #84619b' : '读取选区 / 替换为 …'
          }
        />
        <button disabled={!allowed || busy || !selection || !command.trim()}>
          发送
        </button>
      </form>
    </div>
  )
  const socket = new URL(launch?.collabUrl || '/collaboration', location.href)
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:'
  return (
    <>
      <section
        className="embed-stage"
        aria-label={board ? '嵌入的白板' : '嵌入的文档'}
      >
        {launch ? (
          <EmbeddedHcdEditor
            documentId={launch.documentId}
            title={file.name}
            token={launch.token}
            apiUrl="/v1/documents"
            collabUrl={socket.href}
            locale="zh-CN"
            chatPanel={chat ? pane : false}
            onSelectionChange={report}
            onSpecRewriteRequest={allowed ? async target=>{report(target);await connect();openChat();setCommand(c=>c || (account.demoAgent?.model?'请改写这句话，使表达更清晰。':'改写为：'));requestAnimationFrame(()=>document.getElementById('agent-message')?.focus())} : undefined}
            onError={(e) => setError(e.message)}
          />
        ) : (
          <p className="embed-wait">正在连接编辑器…</p>
        )}
      </section>
      <section className="agent-dock" aria-label="外部 Agent">
        <div className="dock-head">
          <div>
            <h2>外部 Agent</h2>
            <small>
              {!account.workspace.selectionMcp
                ? '此工作区尚未启用选区 MCP'
                : !allowed
                  ? '当前文件未授权外部 Agent'
                  : selection?.target.kind==='spec' ? 'Spec 选句 · '+selection.target.expected
                : count
                    ? '已选中 ' + count + (board ? ' 个对象' : ' 段文字')
                    : help}
            </small>
          </div>
          <button
            className="connect"
            disabled={!allowed || !selection || busy}
            onClick={() => void execute('connect')}
          >
            {grant ? '已连接选区' : '连接当前选区'}
          </button>
        </div>
        <div className="dock-tools">
          <button
            disabled={!allowed || !selection || busy}
            onClick={() => void execute('read')}
          >
            读取选区
          </button>
          {board && (
            <>
              <button
                disabled={!allowed || !selection || busy}
                onClick={() => void execute('move')}
              >
                向右移动 24
              </button>
              <button
                disabled={!allowed || !selection || busy}
                onClick={() => void execute('color', '#785a8e')}
              >
                <i className="violet" />
                改为紫色
              </button>
            </>
          )}
          <input
            aria-label="替换内容"
            placeholder="输入替换文字"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            disabled={!allowed || !selection || !value || busy}
            onClick={() => void execute('replace', value)}
          >
            替换选中文字
          </button>
        </div>
        {grant && (
          <details>
            <summary>外部连接信息</summary>
            <code>{grant.endpoint}</code>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(grant.token)
                  .then(() => setNotice('已复制选区凭据。'))
                  .catch(() => setError('浏览器未允许复制。'))
              }
            >
              复制短期凭据
            </button>
            <button
              onClick={() => {
                clear()
                setNotice('已断开选区连接。')
              }}
            >
              断开连接
            </button>
          </details>
        )}
        {notice && (
          <p role="status" className="agent-receipt">
            {notice}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  query.has('manual') ? (
    <ManualHost />
  ) : (
    <AccountGate>
      {(account) =>
        query.get('standalone') === '1' ||
        query.get('example') === 'selection' ||
        location.pathname.startsWith('/embed-example') ? (
          <Project account={account} />
        ) : (
          <OfficeDesk key={account.user.id} account={account} />
        )
      }
    </AccountGate>
  ),
)
