import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Folder, Layers2, ListFilter, LoaderCircle, Pin, PinOff, Plus, RotateCcw, Search, X } from 'lucide-react'
import type { Session } from './api.ts'
import { useI18n } from './i18n.tsx'
import { localizeSource } from './sourceLocale.tsx'
import { FormatIcon } from './WorkspaceLibrary.tsx'
import { useWorkspaceAgentTabActivity, useWorkspaceTabWriting } from './WorkspaceAgent.tsx'
import { useWorkflowWorkspace } from './WorkflowWorkspace.tsx'
import type { SavedTab, TabGroup } from './workspaceSession.ts'
import { AgentPointer } from './AgentPointer'
import { AppearanceSelect } from './Appearance'
import './document-tabs.css'

type Props = {
  sessions: Session[]
  active: string | null
  pinned: string[]
  recent: SavedTab[]
  groups: TabGroup[]
  activate: (id: string | null) => void
  pin: (id: string) => void
  move: (id: string, direction: -1 | 1) => void
  reorder: (id: string, target: string, after: boolean) => void
  assignGroup: (ids: string[], groupId: string | null, newName?: string) => void
  updateGroup: (id: string, update: Partial<Pick<TabGroup, 'name' | 'collapsed'>>) => void
  onSaving: (ids: string[]) => void
  onClose: (sessions: Session[]) => void
  reopen: (tab: SavedTab) => Promise<boolean>
  forget: (id: string) => void
}

export function DocumentTabs({ sessions, active, pinned, recent, groups, activate, pin, move, reorder, assignGroup, updateGroup, onSaving, onClose, reopen, forget }: Props) {
  const { locale } = useI18n()
  const t = (source: string) => localizeSource(locale, source)
  const workflow = useWorkflowWorkspace()
  const isWorking = useWorkspaceAgentTabActivity(), isWriting = useWorkspaceTabWriting()
  const list = useRef<HTMLDivElement>(null), menu = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const currentAction = useRef(false)
  const [pending, setPending] = useState<string[]>([])
  const [marked, setMarked] = useState<string[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const dragging = useRef<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; side: 'before' | 'after' | 'group' } | null>(null)
  const [lastReopen, setLastReopen] = useState<string | null>(null)
  const groupOf = (id: string) => groups.find(group => group.members.includes(id))
  const visible = sessions.filter(session => !groupOf(session.documentId)?.collapsed || session.documentId === active)
  const busy = pending.length > 0

  useEffect(() => {
    if (!active) return
    const row = [...(list.current?.children || [])].find(element => (element as HTMLElement).dataset.tabId === active)
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, sessions, groups])

  function showManager() {
    if (!menu.current || menu.current.open) return
    setQuery('')
    setStatus('')
    setMarked([])
    setCreatingGroup(false)
    setGroupName('')
    menu.current.showModal()
    search.current?.focus()
  }

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'KeyT' || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      showManager()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  async function close(requested: Session[]) {
    if (currentAction.current || !requested.length) return
    currentAction.current = true
    const ids = requested.map(session => session.documentId)
    setPending(ids)
    onSaving(ids)
    setStatus('')
    try {
      // Inert panels have had a frame to finish their blur handlers.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const saved: Session[] = [], kept: string[] = []
      const keep = (session: Session, reason: string) => {
        kept.push(requested.length === 1 ? reason : `${session.title || session.documentId} · ${reason}`)
      }
      for (const session of requested) {
        try {
          if (pinned.includes(session.documentId)) throw new Error(t('请先取消固定'))
          if (isWorking(session)) throw new Error(t('AI 执行中'))
          if (!workflow) throw new Error(t('工作空间尚未就绪。'))
          await workflow.prepare([session])
          saved.push(session)
        } catch (cause) {
          keep(session, cause instanceof Error ? cause.message : String(cause))
        }
      }
      // AI can start from another panel while the batch saves.
      const closable = saved.filter(session => {
        if (!isWorking(session)) return true
        keep(session, t('AI 执行中'))
        return false
      })
      onClose(closable)
      setMarked(previous => previous.filter(id => !closable.some(session => session.documentId === id)))
      if (kept.length) setStatus(kept.join('\n'))
    } finally {
      currentAction.current = false
      onSaving([])
      setPending([])
    }
  }

  function clearDrag() {
    dragging.current = null
    setDropHint(null)
  }
  function dragSide(event: DragEvent<HTMLElement>) {
    const rectangle = event.currentTarget.getBoundingClientRect()
    return event.clientX >= rectangle.left + rectangle.width / 2 ? 'after' : 'before'
  }
  function dragOver(event: DragEvent<HTMLElement>, id: string, fixed: boolean, group = false) {
    const source = dragging.current
    if (!source || source === id || pinned.includes(source) !== fixed) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const side = group ? 'group' : dragSide(event)
    setDropHint(previous => previous?.id === id && previous.side === side ? previous : { id, side })
  }
  function drop(event: DragEvent<HTMLElement>, id: string, group = false) {
    const source = dragging.current
    if (!source) return
    event.preventDefault()
    if (group && !pinned.includes(source)) assignGroup([source], id)
    if (!group) reorder(source, id, dragSide(event) === 'after')
    clearDrag()
  }

  async function restore(tab: SavedTab) {
    if (currentAction.current) return
    currentAction.current = true
    setPending([tab.documentId])
    setStatus('')
    try {
      if (await reopen(tab)) {
        menu.current?.close()
      } else {
        setLastReopen(tab.documentId)
        setStatus(t('无法重新打开。请在工作台重新连接文件，或稍后重试。'))
      }
    } finally {
      currentAction.current = false
      setPending([])
    }
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number, id: string) {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    if (event.altKey) {
      move(id, direction)
      return
    }
    const neighbor = visible[(index + direction + visible.length) % visible.length]
    activate(neighbor.documentId)
    const row = list.current?.querySelector(`[data-tab-id="${CSS.escape(neighbor.documentId)}"]`)
    row?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }

  const terms = query.trim().toLocaleLowerCase()
  const matches = (tab: SavedTab, format = '') => `${tab.title || ''} ${tab.documentId} ${format}`.toLocaleLowerCase().includes(terms)
  const results = sessions.filter(session => matches(session, session.format))
  const closed = recent.filter(tab => matches(tab))
  const selected = sessions.filter(session => marked.includes(session.documentId))
  const groupable = selected.filter(session => !pinned.includes(session.documentId)).map(session => session.documentId)

  function groupHeader(group: TabGroup) {
    return <button key={`group:${group.id}`} className="document-tab-group" aria-expanded={!group.collapsed}
      data-drop={dropHint?.id === group.id ? 'group' : undefined}
      onClick={() => updateGroup(group.id, { collapsed: !group.collapsed })}
      onDragOver={event => dragOver(event, group.id, false, true)} onDrop={event => drop(event, group.id, true)}>
      {group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>{group.name}</span>
    </button>
  }

  function renderTab(session: Session) {
    const id = session.documentId, index = visible.indexOf(session)
    const fixed = pinned.includes(id), working = isWorking(session)
    return <div className={`document-tab ${active === id ? 'active' : ''}`} key={id} data-tab-id={id} data-pinned={fixed} data-format={session.format} data-ai-writing={isWriting(session) || undefined}
      draggable={!busy} data-drop={dropHint?.id === id ? dropHint.side : undefined}
      onDragStart={event => { dragging.current = id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-hcd-tab', id) }}
      onDragOver={event => dragOver(event, id, fixed)} onDrop={event => drop(event, id)} onDragEnd={clearDrag}>
      <button aria-current={active === id ? 'page' : undefined} onClick={() => activate(id)} onKeyDown={event => navigateTabs(event, index, id)} title={id}>
        <FormatIcon format={session.format} size={14} />
        <span>{session.title || id}</span>
        <small>{session.format.toUpperCase()}</small>
        {session.scope === 'read' && <span> · {t('只读')}</span>}
        {fixed && <Pin size={12} className="tab-pin" aria-label={t('已固定')} />}
        {isWriting(session) ? <AgentPointer phase="writing" className="native-tab-cursor" label={t('AI 执行中')} /> : working && <LoaderCircle size={12} className="agent-spinner" aria-label={t('AI 执行中')} />}
      </button>
      {!fixed && <button className="close-document-tab" aria-label={`${t('关闭')} ${id}`} disabled={busy || working} onClick={() => void close([session])}>
        {pending.includes(id) ? <LoaderCircle size={13} className="agent-spinner" /> : <X size={13} />}
      </button>}
    </div>
  }

  return <>
    <nav className="document-tabs" aria-label={t('已打开的文档')}>
      <button className="tabs-brand" aria-label={t('文档工作台')} onClick={() => activate(null)}><Layers2 size={21} /><strong>office.</strong></button>
      <div className="document-tab-strip" ref={list}>
        {sessions.filter(session => pinned.includes(session.documentId)).map(renderTab)}
        {groups.flatMap(group => {
          if (!sessions.some(session => group.members.includes(session.documentId))) return []
          return [groupHeader(group), ...visible.filter(session => group.members.includes(session.documentId)).map(renderTab)]
        })}
        {sessions.filter(session => !pinned.includes(session.documentId) && !groupOf(session.documentId)).map(renderTab)}
      </div>
      <div className="document-tab-actions">
        <button className={active === null ? 'active open-document-tab' : 'open-document-tab'} aria-label={t('打开其他文档')} title={t('打开其他文档')} onClick={() => activate(null)}><Plus size={15} /><span>{t('打开文档')}</span></button>
        <button className="document-tab-manager-trigger" aria-label={t('管理标签页')} title={`${t('管理标签页')} · Alt+Shift+T`} aria-haspopup="dialog" aria-keyshortcuts="Alt+Shift+T" onClick={showManager}><ListFilter size={17} /></button>
      </div>
      <AppearanceSelect global />
    </nav>
    {status && <p className="document-tab-notice" role="alert">{status}<button aria-label={t('关闭提示')} onClick={() => setStatus('')}><X size={14} /></button></p>}
    <dialog ref={menu} className="document-tab-manager" aria-labelledby="document-tab-manager-title">
      <header><div><h2 id="document-tab-manager-title">{t('管理标签页')}</h2><p>{sessions.length} {t('个已打开')}</p></div><button className="tab-icon" aria-label={t('关闭标签管理')} onClick={() => menu.current?.close()}><X size={18} /></button></header>
      <label className="document-tab-search"><Search size={16} /><input ref={search} aria-label={t('搜索标签页')} placeholder={t('搜索文件名或格式')} value={query} onChange={event => setQuery(event.target.value)} /></label>
      {selected.length > 0 && <div className="document-tab-bulk">
        <span>{t('已选')} {selected.length}</span>
        <select aria-label={t('移动到标签组')} value={creatingGroup ? 'new' : ''} disabled={busy || !groupable.length} onChange={event => {
          const value = event.target.value
          setCreatingGroup(value === 'new')
          if (value && value !== 'new') assignGroup(groupable, value === 'ungrouped' ? null : value)
        }}>
          <option value="">{t('移动到标签组')}</option>
          <option value="new">{t('新建标签组')}</option>
          <option value="ungrouped">{t('移出标签组')}</option>
          {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <button disabled={busy} onClick={() => void close(selected)}>{t('关闭所选')}</button>
        {creatingGroup && <form onSubmit={event => {
          event.preventDefault()
          if (!groupable.length || !groupName.trim() || busy) return
          assignGroup(groupable, crypto.randomUUID(), groupName.trim())
          setCreatingGroup(false)
          setGroupName('')
        }}>
          <input aria-label={t('标签组名称')} value={groupName} maxLength={40} autoFocus onChange={event => setGroupName(event.target.value)} />
          <button disabled={!groupable.length || !groupName.trim() || busy}>{t('创建')}</button>
        </form>}
      </div>}
      <div className="document-tab-results">
        {results.map(session => {
          const id = session.documentId, index = sessions.indexOf(session)
          const fixed = pinned.includes(id), working = isWorking(session)
          const group = groupOf(id)
          const canMove = (direction: number) => {
            const neighbor = sessions[index + direction]
            return neighbor && pinned.includes(neighbor.documentId) === fixed && groupOf(neighbor.documentId)?.id === group?.id
          }
          return <div className="document-tab-result" key={id} data-current={active === id}>
            <input type="checkbox" aria-label={`${t('选择标签')} ${id}`} checked={marked.includes(id)} disabled={busy} onChange={event => {
              const checked = event.target.checked
              setMarked(previous => checked ? [...previous, id] : previous.filter(value => value !== id))
            }} />
            <button className="tab-result-name" onClick={() => { activate(id); menu.current?.close() }}><FormatIcon format={session.format} size={18} /><span><strong>{session.title || id}</strong><small>{[session.format.toUpperCase(), group?.name, working ? t('AI 执行中') : session.scope === 'read' ? t('只读') : ''].filter(Boolean).join(' · ')}</small></span></button>
            <button className="tab-icon" aria-label={`${t(fixed ? '取消固定' : '固定')} ${id}`} title={t(fixed ? '取消固定' : '固定')} onClick={() => pin(id)} disabled={busy}>{fixed ? <PinOff size={15} /> : <Pin size={15} />}</button>
            <button className="tab-icon" aria-label={`${t('左移')} ${id}`} title={t('左移')} onClick={() => move(id, -1)} disabled={busy || !canMove(-1)}><ArrowLeft size={15} /></button>
            <button className="tab-icon" aria-label={`${t('右移')} ${id}`} title={t('右移')} onClick={() => move(id, 1)} disabled={busy || !canMove(1)}><ArrowRight size={15} /></button>
            <button className="tab-icon" aria-label={`${t('关闭')} ${id}`} title={t(working ? 'AI 执行中' : fixed ? '请先取消固定' : '关闭')} onClick={() => void close([session])} disabled={busy || fixed || working}>
              {pending.includes(id) ? <LoaderCircle size={15} className="agent-spinner" /> : <X size={15} />}
            </button>
          </div>
        })}
        {!terms && groups.some(group => sessions.some(session => group.members.includes(session.documentId))) && <section className="document-tab-group-list" aria-label={t('标签组')}>
          <h3>{t('标签组')}</h3>
          {groups.filter(group => sessions.some(session => group.members.includes(session.documentId))).map(group => <div className="document-tab-result" key={group.id}>
            <Folder size={15} />
            <input key={group.name} aria-label={`${t('重命名标签组')} ${group.name}`} maxLength={40} defaultValue={group.name} disabled={busy}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              onBlur={event => {
                const name = event.currentTarget.value.trim()
                if (name) updateGroup(group.id, { name })
                else event.currentTarget.value = group.name
              }} />
            <button className="tab-icon" aria-label={`${t('关闭整组')} ${group.name}`} title={t('关闭整组')} disabled={busy}
              onClick={() => void close(sessions.filter(session => group.members.includes(session.documentId)))}><X size={15} /></button>
          </div>)}
        </section>}
        {!!closed.length && <h3>{t('最近关闭')}</h3>}
        {closed.map(tab => <div className="document-tab-result" key={tab.documentId}>
          <button className="tab-result-name" onClick={() => void restore(tab)} disabled={busy} aria-label={`${t('重新打开')} ${tab.documentId}`}>
            {pending.includes(tab.documentId) ? <LoaderCircle size={16} className="agent-spinner" /> : <RotateCcw size={16} />}
            <span><strong>{tab.title || tab.documentId}</strong>{lastReopen === tab.documentId && <small>{t('请重新连接')}</small>}</span>
          </button>
          <button className="tab-icon" aria-label={`${t('移除记录')} ${tab.documentId}`} title={t('移除记录')} onClick={() => forget(tab.documentId)} disabled={busy}><X size={15} /></button>
        </div>)}
        {!results.length && !closed.length && <p className="tab-empty">{t('没有匹配的标签页。')}</p>}
      </div>
      {status && <p className="tab-manager-status" role="alert">{status}</p>}
    </dialog>
  </>
}
