import { useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Home, Monitor, Moon, Plus, RotateCcw, Sun, X } from 'lucide-react'
import { EmbeddedWorkspace, type HcdEmbedSelection, type BoardExcerpt, type HcdWorkspaceSearchLocation, AgentCompanionMark, AgentPointer, AppearanceProvider, useAppearance, type Appearance } from '@officecli/hcd-reference-editor/react'
import { api, mutation, type Launch, type Account, type FileEntry } from './hostApi'
import {
  baseName,
  createKinds,
  failText,
  FileGlyph,
  kindOf,
  fileCursorColors, selectionKey,
  kinds,
  type FileKind,
} from './deskFiles'
import { DeskPane, type PaneHandle, type PaneState } from './DeskPane'
import { DeskAgent, useDeskTasks } from './DeskAgent'
import { DeskHome } from './DeskHome'
import { DeskMentions, type DeskMention } from './DeskMentions'
import './office-desk.css'

declare global {
  interface Window {
    foldlyPrepareToQuit?: () => Promise<void>
  }
}

type Composer = { text: string; targets: string[]; selections: Record<string, string> }
type Layout = {
  tabs: string[]
  active: string
  closed: string[]
  recent: string[]
  stars: string[]
  groups: Record<string, string>
  picked: string[]
  chat: boolean
  composers: Record<string, Composer>
}
const home = 'home'
function readLayout(key: string): Layout {
  const blank: Layout = {
    tabs: [],
    active: home,
    closed: [],
    recent: [],
    stars: [],
    groups: {},
    picked: [],
    chat: window.innerWidth > 920,
    composers: {},
  }
  try {
    const s = JSON.parse(localStorage.getItem(key) || 'null')
    if (!s || typeof s !== 'object') return blank
    for (const k of ['tabs', 'closed', 'recent', 'stars', 'picked'] as const)
      if (Array.isArray(s[k]))
        blank[k] = [
          ...new Set<string>(
            s[k].filter((v: unknown) => typeof v === 'string'),
          ),
        ]
    if (typeof s.active === 'string') blank.active = s.active
    for (const [id, saved] of Object.entries(s.composers || {})) {
      const c = saved as Partial<Composer> | null
      if (c && typeof c.text === 'string' && Array.isArray(c.targets))
        blank.composers[id] = { text: c.text.slice(0, 4000), targets: c.targets.filter(id => typeof id === 'string').slice(0, 12),
          selections: Object.fromEntries(Object.entries(c.selections || {}).filter(([, v]) => typeof v === 'string')) }
    }
    if (typeof s.draft === 'string' && s.draft && !blank.composers[blank.active])
      blank.composers[blank.active] = { text: s.draft.slice(0, 4000), targets: blank.picked,
        selections: Object.fromEntries(blank.picked.map(id => [id, 'unconfirmed'])) }
    if (typeof s.chat === 'boolean') blank.chat = s.chat
    if (s.groups && typeof s.groups === 'object')
      blank.groups = Object.fromEntries(
        Object.entries(s.groups).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>
  } catch {}
  return blank
}
const front = (ids: string[], id: string) =>
  [id, ...ids.filter((i) => i !== id)].slice(0, 100)
function DeskBrand() {
  return (
    <div className="desk-brand" aria-label="折页 Office">
      <svg aria-hidden="true" width="31" height="31" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="9" fill="currentColor" />
        <path d="M6 21 13.2 8.8c.6-1 1.1-1.4 2-1.4h9.5L17 21Z" fill="var(--desk-surface)" />
        <path
          d="m14.5 23.7 8.3-13.8 3.1 5.1-5 8.7Z"
          fill="var(--desk-surface)"
          opacity=".60"
        />
      </svg>
      <strong>
        折页 <em>Office</em>
      </strong>
    </div>
  )
}
export function OfficeDesk({ account }: { account: Account }) {
  return <AppearanceProvider persist><DeskWorkspace account={account} /></AppearanceProvider>
}

function DeskWorkspace({ account }: { account: Account }) {
  const desk = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const viewport = window.visualViewport, element = desk.current
    if (!viewport || !element) return
    // Pin the chrome and dock to the visible area during pinch zoom and keyboard resizes.
    const fit = () => {
      element.style.setProperty('--desk-visible-height', viewport.height + 'px')
      element.style.setProperty('--desk-visible-width', viewport.width + 'px')
      element.style.setProperty('--desk-visible-top', viewport.offsetTop + 'px')
      element.style.setProperty('--desk-visible-left', viewport.offsetLeft + 'px')
    }
    fit()
    viewport.addEventListener('resize', fit)
    viewport.addEventListener('scroll', fit)
    return () => {
      viewport.removeEventListener('resize', fit)
      viewport.removeEventListener('scroll', fit)
    }
  }, [])
  const { preference, theme, setPreference } = useAppearance()
  const desktop = account.workspace.mode === 'desktop'
  const ThemeIcon = preference === 'system' ? Monitor : theme === 'dark' ? Moon : Sun
  const key =
    'officecli:desk:v1:' +
    JSON.stringify([
      account.workspace.tenantId,
      account.workspace.appId,
      account.user.id,
    ])
  const [layout, setLayout] = useState(() => {
      const saved = readLayout(key),
        requested = new URLSearchParams(location.search).get('ai')
      if (requested === '1' || requested === '0') saved.chat = requested === '1'
      return saved
    }),
    [catalog, setCatalog] = useState<FileEntry[]>([]),
    [ready, setReady] = useState(false),
    [error, setError] = useState('')
  const [states, setStates] = useState<Record<string, PaneState>>({}),
    handles = useRef(new Map<string, PaneHandle>())
  useEffect(() => {
    if (!desktop) return
    window.foldlyPrepareToQuit = async () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await Promise.all([...handles.current.values()].map(pane => pane.prepare()))
    }
    return () => { delete window.foldlyPrepareToQuit }
  }, [desktop])
  const catalogGeneration = useRef(0)
  const refreshFiles = useCallback(async () => {
    const generation = ++catalogGeneration.current
    const { files } = await api<{ files: FileEntry[] }>('/files')
    if (generation !== catalogGeneration.current) return
    const readable = new Set(files.map(file => file.id))
    setCatalog(files)
    setLayout(previous => {
      const tabs = previous.tabs.filter(id => readable.has(id))
      if (tabs.length === previous.tabs.length) return previous
      return { ...previous, tabs, picked: previous.picked.filter(id => readable.has(id)),
        active: readable.has(previous.active) ? previous.active : home }
    })
  }, [])
  function fileChanged(file: FileEntry) {
    catalogGeneration.current++
    setCatalog(items => items.some(item => item.id === file.id)
      ? items.map(item => item.id === file.id ? file : item) : [file, ...items])
  }
  const [menu, setMenu] = useState<'new' | 'tabs' | null>(null),
    [checked, setChecked] = useState<string[]>([]),
    [group, setGroup] = useState(''),
    [creating, setCreating] = useState<FileKind | null>(null)
  function rewriteSentence(id: string, selection: HcdEmbedSelection) {
    setLayout(s => ({ ...s, chat: true, picked: [id], composers: { ...s.composers, [id]: {
      text: s.composers[id]?.text || (account.workspace.workbenchModel ? '请改写选中的这句话，使表达更清晰。' : '改写为：'),
      targets: [id], selections: { [id]: selectionKey(selection) },
    } } }))
    requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>('.desk-compose textarea')?.focus())
  }
  useEffect(() => {
    function boardAi(event: Event) {
      const target=event.target
      if(!(target instanceof Element))return
      const id=target.closest<HTMLElement>('.desk-editor.is-visible[data-file-id]')?.dataset.fileId
      if (id) setLayout(s => {
        const c = s.composers[id]
        const picked = [...new Set([...(c?.targets || s.picked), id])].slice(-12)
        return { ...s, chat: true, picked, composers: { ...s.composers, [id]: { text: c?.text || '', targets: picked, selections: c?.selections || {} } } }
      })
    }
    window.addEventListener('officecli:board-ai',boardAi)
    return ()=>window.removeEventListener('officecli:board-ai',boardAi)
  },[])
  const dragged = useRef(''),
    pop = useRef<HTMLDivElement>(null),
    opener = useRef<HTMLButtonElement | null>(null)
  const {
    jobs,
    run,
    transition,
    editing,
    recent: activity,
    names: agentNames,
    heads,
    locks,
  } = useDeskTasks(account, handles, states, layout.tabs.length > 0)
  const cursors = useMemo(() => fileCursorColors(catalog), [catalog])
  const byId = new Map(catalog.map((f) => [f.id, f]))
  const tabs = layout.tabs.flatMap((id) => byId.get(id) || [])
  useEffect(() => {
    let alive = true
    api<{ files: FileEntry[] }>('/files')
      .then(({ files }) => {
        if (!alive) return
        setCatalog(files)
        const valid = new Set(files.map((f) => f.id)),
          params = new URLSearchParams(location.search),
          requested = params.get('file')
        const view = params.get('view'),
          legacy = view
            ? files.find(
                (f) =>
                  kindOf(f.format) === (view === 'board' ? 'board' : 'doc'),
              )?.id
            : undefined
        if (requested && !valid.has(requested))
          setError('此文件不存在或已撤销访问权限。')
        setLayout((s) => {
          const selected =
            requested && valid.has(requested)
              ? requested
              : !requested
                ? legacy
                : undefined
          const ids = s.tabs.filter((id) => valid.has(id))
          if (selected && !ids.includes(selected)) ids.push(selected)
          return {
            ...s,
            tabs: ids,
            active:
              selected ||
              (!requested && ids.includes(s.active) ? s.active : home),
            closed: s.closed.filter((id) => valid.has(id)),
            recent: s.recent.filter((id) => valid.has(id)),
            stars: s.stars.filter((id) => valid.has(id)),
            picked: s.picked.filter((id) => ids.includes(id)),
            composers: Object.fromEntries(Object.entries(s.composers).filter(([id]) => id === home || valid.has(id))),
          }
        })
      })
      .catch((e) => {
        if (alive) setError(failText(e))
      })
      .finally(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [key])
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem(key, JSON.stringify(layout))
      } catch {}
  }, [key, layout, ready])
  useEffect(() => {
    if (!ready) return
    const url = new URL(location.href)
    if(url.searchParams.get('file')!==layout.active)url.searchParams.delete('node-id')
    url.searchParams.delete('view')
    url.searchParams.delete('ai')
    if (layout.active !== home) url.searchParams.set('file', layout.active)
    else url.searchParams.delete('file')
    history.replaceState(null, '', url)
    document.title =
      (catalog.find((f) => f.id === layout.active)?.name || '工作空间') +
      ' · 折页 Office'
  }, [ready, layout.active, catalog])
  useEffect(() => {
    if (!menu) return
    const down = (e: PointerEvent) => {
      if (
        !pop.current?.contains(e.target as Node) &&
        !opener.current?.contains(e.target as Node)
      )
        setMenu(null)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null)
        opener.current?.focus()
      }
    }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', esc)
    }
  }, [menu])
  const publish = useCallback((id: string, state: PaneState) => {
    setStates((s) => {
      const p = s[id]
      return p?.ready === state.ready &&
        p.scope === state.scope &&
        p.mode === state.mode && p.selectionKey === state.selectionKey
        ? s
        : { ...s, [id]: state }
    })
  }, [])
  const composerId = layout.active
  const composer = layout.composers[composerId]
  const picked = composer?.targets ?? (composerId === home || layout.picked.includes(composerId) ? layout.picked : [composerId])
  const changedScope = picked.some(id => !layout.tabs.includes(id) || (composer?.text && composer.selections[id] &&
    states[id]?.ready && composer.selections[id] !== states[id].selectionKey))
  const selectionKeys = (ids: string[]) => Object.fromEntries(ids.map(id =>
    [id, states[id]?.ready ? states[id].selectionKey : 'unconfirmed']))
  function selectTargets(ids: string[], confirmCurrent = false) {
    setLayout(s => {
      const previous = s.composers[composerId]
      const selections = selectionKeys(ids)
      if (previous?.text && !confirmCurrent) {
        for (const id of ids) {
          if (previous.selections[id]) selections[id] = previous.selections[id]
        }
      }
      return { ...s, picked: ids, composers: { ...s.composers, [composerId]: {
        text: previous?.text || '', targets: ids, selections,
      } } }
    })
  }
  function setDraft(text: string, restoreIfEmpty = false) {
    setLayout(s => {
      const previous = s.composers[composerId]
      if (restoreIfEmpty && previous?.text) return s
      const selections = previous?.text ? { ...selectionKeys(picked), ...previous.selections } : selectionKeys(picked)
      return { ...s, composers: { ...s.composers, [composerId]: { text, targets: picked, selections: text ? selections : {} } } }
    })
  }
  const [searchLocation, setSearchLocation] = useState<HcdWorkspaceSearchLocation>()
  function open(id: string) {
    if (id === home || byId.has(id)) activateTab(id)
  }
  function activateTab(id: string, result?: HcdWorkspaceSearchLocation) {
    setSearchLocation(result)
    const showFileOnly = window.matchMedia('(max-width: 860px)').matches
    setMenu(null)
    setError('')
    setLayout((s) => ({
      ...s,
      active: id,
      chat: showFileOnly ? false : s.chat,
      tabs: id === home || s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
      recent: id === home ? s.recent : front(s.recent, id),
      closed: s.closed.filter((f) => f !== id),
    }))
  }
  async function openMention(item: DeskMention) {
    if (!byId.has(item.fileId)) {
      const { file } = await api<{ file: FileEntry }>('/files/' + item.fileId)
      fileChanged(file)
    }
    const url = new URL(location.href)
    url.searchParams.delete('doc-id')
    url.searchParams.set('file', item.fileId)
    url.searchParams.set('node-id', item.elementId)
    history.replaceState(history.state, '', url.href)
    activateTab(item.fileId)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  const resourceFiles = useMemo(() => catalog.map(file => ({
    documentId: file.resourceDocumentId, title: file.name, format: file.format, writable: file.operations.includes('document.edit'),
    canAsk: file.canDelegateSelection,
  })), [catalog])
  const fileFor = (docId: string) => catalog.find(file => file.resourceDocumentId === docId)
  const resourceSelection = (docId: string) => handles.current.get(fileFor(docId)?.id || '')?.selection() || null
  const mentionable = useCallback(async (docId:string) => {
    const file=catalog.find(item=>item.resourceDocumentId===docId)
    if(!file)return []
    const {people}=await api<{people:{id:string;name:string}[]}>('/files/'+file.id+'/mentionable')
    // Integration sessions publish this pseudonymous subject in presence and comment records.
    return Promise.all(people.map(async person=>{
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(person.id)))
      return {name:person.name,id:'host-'+Array.from(digest.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('')}
    }))
  }, [catalog])
  const resourceAccess = async (docId: string) => {
    const file = fileFor(docId)
    if (!file) throw Error('源文件不可访问。')
    const launch = await api<Launch>('/files/' + file.id + '/editor-session', mutation(account.csrf, { sessionId: crypto.randomUUID() }))
    if (launch.documentId !== docId) throw Error('源文件已变化，请重新选择。')
    return { token: launch.token, apiUrl: '/v1/documents' }
  }
  const askResource = (selection: HcdEmbedSelection) => {
    const file = fileFor(selection.documentId)
    if (!file?.canDelegateSelection) throw Error('没有编辑此文件选区的 AI 权限。')
    const id = file.id
    setLayout(s => ({ ...s, active: id, chat: true, picked: [id], composers: { ...s.composers,
      [id]: { text: s.composers[id]?.text || '', targets: [id],
        selections: { [id]: selectionKey(selection) } },
    } }))
  }
  function added(file: FileEntry) {
    const showFileOnly = window.matchMedia('(max-width: 860px)').matches
    fileChanged(file)
    setLayout((s) => ({
      ...s,
      tabs: [...s.tabs.filter((f) => f !== file.id), file.id],
      active: file.id,
      chat: showFileOnly ? false : s.chat,
      recent: front(s.recent, file.id),
    }))
  }
  async function close(ids: string[]) {
    if (!ids.length) return
    try {
      if (ids.some((id) => locks.current.has(id) || editing.has(id)))
        throw Error('AI 正在处理选中的标签，请等待任务完成。')
      for (const id of ids) await handles.current.get(id)?.prepare()
      if (ids.some((id) => locks.current.has(id) || editing.has(id)))
        throw Error('标签收到新的 AI 任务，请稍后关闭。')
      setLayout((s) => {
        const rest = s.tabs.filter((id) => !ids.includes(id))
        const index = s.tabs.indexOf(s.active)
        return {
          ...s,
          tabs: rest,
          active: ids.includes(s.active)
            ? rest[Math.min(index, rest.length - 1)] || home
            : s.active,
          closed: [
            ...ids.slice().reverse(),
            ...s.closed.filter((id) => !ids.includes(id)),
          ].slice(0, 30),
          picked: s.picked.filter((id) => !ids.includes(id)),
        }
      })
      setChecked([])
      setMenu(null)
    } catch (e) {
      setError(failText(e))
    }
  }
  function reorder(a: string, b: string) {
    if (!a || a === b) return
    setLayout((s) => {
      if (!s.tabs.includes(a) || !s.tabs.includes(b)) return s
      const tabs = s.tabs.filter((id) => id !== a)
      tabs.splice(s.tabs.indexOf(b), 0, a)
      return { ...s, tabs }
    })
  }
  function groupTabs() {
    if (!checked.length) return
    const label = group.trim().slice(0, 18)
    setLayout((s) => {
      const groups = { ...s.groups }
      for (const id of checked) {
        if (label) groups[id] = label
        else delete groups[id]
      }
      const members = s.tabs.filter((id) => checked.includes(id)),
        rest = s.tabs.filter((id) => !checked.includes(id))
      rest.splice(s.tabs.indexOf(members[0]), 0, ...members)
      return { ...s, groups, tabs: rest }
    })
    setGroup('')
    setChecked([])
    setMenu(null)
  }
  function startCreate(kind: FileKind) {
    open(home)
    setCreating(kind)
  }
  const refs = useRef(new Map<string, (el: PaneHandle | null) => void>())
  function paneRef(id: string) {
    if (!refs.current.has(id))
      refs.current.set(id, (el) => {
        if (el) handles.current.set(id, el)
        else handles.current.delete(id)
      })
    return refs.current.get(id)!
  }
  function toggleMenu(which: 'tabs' | 'new', el: HTMLButtonElement) {
    opener.current = el
    setMenu(menu === which ? null : which)
    setChecked([])
  }
  function navigate(e: React.KeyboardEvent, id: string) {
    const ids = [home, ...layout.tabs],
      i = ids.indexOf(id)
    const to =
      e.key === 'ArrowRight'
        ? ids[(i + 1) % ids.length]
        : e.key === 'ArrowLeft'
          ? ids[(i - 1 + ids.length) % ids.length]
          : e.key === 'Home'
            ? home
            : e.key === 'End'
              ? ids.at(-1)
              : undefined
    if (to) {
      e.preventDefault()
      open(to)
      document.getElementById('tab-' + to)?.focus()
    }
  }
  return (
    <div ref={desk} className="office-desk" data-theme={theme}>
      <header className="desk-chrome">
        <DeskBrand />
        <div className="desk-tabs" role="tablist" aria-label="打开的文件">
          <button
            role="tab"
            id="tab-home"
            aria-selected={layout.active === home}
            aria-controls="desk-home-pane"
            tabIndex={layout.active === home ? 0 : -1}
            className={
              'desk-home-tab' + (layout.active === home ? ' active' : '')
            }
            onClick={() => open(home)}
            onKeyDown={(e) => navigate(e, home)}
          >
            <Home size={16} />
            首页
          </button>
          {tabs.map((f) => {
            const k = kindOf(f.format),
              writing = editing.has(f.id),
              phase = writing ? 'editing' : activity.get(f.id),
              authors = [...(agentNames.get(f.id) || ['墨点'])].join('、'),
              g = layout.groups[f.id]
            return (
              <div
                key={f.id}
                className={
                  'desk-file-tab' + (layout.active === f.id ? ' active' : '')
                }
                data-phase={phase}
                data-file-id={f.id}
                draggable
                onDragStart={(e) => {
                  dragged.current = f.id
                  e.dataTransfer.setData('text/plain', f.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  reorder(dragged.current, f.id)
                  dragged.current = ''
                }}
                onDragEnd={() => {
                  dragged.current = ''
                }}
              >
                <button
                  id={'tab-' + f.id}
                  role="tab"
                  aria-label={f.name + (writing ? '，AI 编辑中' : '')}
                  aria-selected={layout.active === f.id}
                  aria-controls={'pane-' + f.id}
                  tabIndex={layout.active === f.id ? 0 : -1}
                  title={
                    (g ? g + ' / ' : '') +
                    f.name +
                    (writing ? ' · AI · '+authors+' 编辑中' : '')
                  }
                  onClick={() => open(f.id)}
                  onKeyDown={(e) => navigate(e, f.id)}
                >
                  <FileGlyph kind={k} size={15} />
                  <span>
                    {g && <small>{g}</small>}
                    {baseName(f.name)}
                  </span>
                  {writing ? (
                    <AgentPointer phase="writing" className="desk-tab-pointer" color={cursors.get(f.id) || 'currentColor'} />
                  ) : phase === 'complete' ? (
                    <Check
                      className="desk-tab-check"
                      size={12}
                      aria-label="AI 已保存"
                    />
                  ) : null}
                </button>
                <button
                  className="desk-tab-x"
                  aria-label={'关闭 ' + f.name}
                  disabled={locks.current.has(f.id) || writing}
                  onClick={() => void close([f.id])}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
        <div className="desk-tab-actions">
          <button
            aria-label="新建标签"
            title="新建标签"
            aria-expanded={menu === 'new'}
            onClick={(e) => toggleMenu('new', e.currentTarget)}
          >
            <Plus size={19} />
          </button>
          <button
            aria-label="管理标签"
            title="管理标签"
            aria-expanded={menu === 'tabs'}
            onClick={(e) => toggleMenu('tabs', e.currentTarget)}
          >
            <ChevronDown size={15} />
          </button>
        </div>
        <label className="desk-appearance" title="界面主题">
          <ThemeIcon size={16} aria-hidden="true" />
          <select aria-label="界面主题" value={preference} onChange={event => setPreference(event.target.value as Appearance)}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        {!desktop && <DeskMentions csrf={account.csrf} openFile={openMention} />}
        {!desktop && <button
          className={'desk-global-toggle' + (layout.chat ? ' on' : '')}
          aria-pressed={layout.chat}
          onClick={() => setLayout((s) => ({ ...s, chat: !s.chat }))}
        >
          <AgentCompanionMark
            size={23}
            state={jobs.some((j) => !j.done) ? 'active' : 'still'}
          />
          全局 AI{editing.size > 0 && <b>{editing.size}</b>}
        </button>}
        {menu && (
          <div ref={pop} className="desk-tab-menu">
            {menu === 'new' ? (
              <>
                <h3>新建文件</h3>
                {createKinds.map((k) => (
                  <button key={k} onClick={() => startCreate(k)}>
                    <FileGlyph kind={k} />
                    {kinds[k].label}
                    <Plus size={13} />
                  </button>
                ))}
              </>
            ) : (
              <>
                <h3>管理标签</h3>
                {tabs.length ? (
                  <>
                    <div className="desk-manage-list">
                      {tabs.map((f) => (
                        <label key={f.id}>
                          <input
                            type="checkbox"
                            checked={checked.includes(f.id)}
                            onChange={() =>
                              setChecked((s) =>
                                s.includes(f.id)
                                  ? s.filter((i) => i !== f.id)
                                  : [...s, f.id],
                              )
                            }
                          />
                          <FileGlyph kind={kindOf(f.format)} size={15} />
                          {baseName(f.name)}
                        </label>
                      ))}
                    </div>
                    <div className="desk-group-input">
                      <input
                        placeholder="分组名称"
                        aria-label="分组名称"
                        value={group}
                        onChange={(e) => setGroup(e.target.value)}
                      />
                      <button disabled={!checked.length} onClick={groupTabs}>
                        {group.trim() ? '分组' : '取消分组'}
                      </button>
                    </div>
                    <button
                      disabled={!checked.length}
                      onClick={() => void close(checked)}
                    >
                      <X size={15} />
                      关闭选中标签
                    </button>
                  </>
                ) : (
                  <p>尚未打开文件</p>
                )}
                <h3>最近关闭</h3>
                {layout.closed.length ? (
                  layout.closed.slice(0, 8).map((id) => (
                    <button key={id} onClick={() => open(id)}>
                      <RotateCcw size={13} />
                      {byId.get(id)?.name}
                    </button>
                  ))
                ) : (
                  <p>没有最近关闭的标签</p>
                )}
              </>
            )}
          </div>
        )}
      </header>
      <div className="desk-body" data-canvas={kindOf(byId.get(layout.active)?.format ?? '') === 'board' || undefined}>
        <div className="desk-content">
          <div
            role="tabpanel"
            id="desk-home-pane"
            aria-label="首页"
            className={
              'desk-home-container' +
              (layout.active === home ? ' is-visible' : '')
            }
            inert={layout.active !== home}
            aria-hidden={layout.active !== home}
          >
            {ready ? (
              <DeskHome
                account={account}
                files={catalog}
                stars={layout.stars}
                recent={layout.recent}
                star={(id) =>
                  setLayout((s) => ({
                    ...s,
                    stars: s.stars.includes(id)
                      ? s.stars.filter((i) => i !== id)
                      : [...s.stars, id],
                  }))
                }
                open={open}
                openContent={async ({ fileId, revision, query, hit }) => {
                  try {
                    let source = byId.get(fileId)
                    if (!source) {
                      source = (await api<{ file: FileEntry }>('/files/' + fileId)).file
                      fileChanged(source)
                    }
                    activateTab(fileId, { requestId: crypto.randomUUID(), documentId: source.resourceDocumentId, revision, query, hit })
                  } catch (error) {
                    setError(failText(error))
                  }
                }}
                add={added}
                fileChanged={fileChanged}
                refreshFiles={refreshFiles}
                creating={creating}
                setCreating={setCreating}
                error={error}
              />
            ) : (
              <p className="desk-loading">正在读取工作空间…</p>
            )}
          </div>
          <EmbeddedWorkspace mentionable={desktop ? undefined : mentionable} searchLocation={searchLocation} activeDocumentId={byId.get(layout.active)?.resourceDocumentId || null} files={resourceFiles}
            activate={docId => { const file = fileFor(docId); if (file) open(file.id) }} selection={resourceSelection} access={resourceAccess}
            organize={account.workspace.workbenchModel ? async (id, excerpts) => {
              const sources = [...new Set(excerpts.flatMap(s => s.documentId ? [fileFor(s.documentId)!.id] : []))]
              const sections = excerpts.map(s => ({id:s.id, heading:s.heading || '', lines:s.lines}))
              return (await api<{sections: BoardExcerpt[]}>('/board-document-preview', mutation(account.csrf, {boardId:fileFor(id)!.id, sources, sections}))).sections
            } : undefined}
            ask={account.workspace.selectionMcp ? askResource : undefined} sourceLink={(docId, nodeId) => {
              const url = new URL('/workbench/', location.origin)
              url.searchParams.set('file', fileFor(docId)!.id); url.searchParams.set('node-id', nodeId)
              return url.href
            }}>
          {tabs.map((f) => (
            <DeskPane
              key={f.id}
              ref={paneRef(f.id)}
              file={f}
              committedRevision={heads.get(f.id)}
              account={account}
              visible={layout.active === f.id}
              onState={publish}
              onSpecRewrite={rewriteSentence}
            />
          ))}
          </EmbeddedWorkspace>
          {error && layout.active !== home && (
            <button
              className="desk-toast"
              role="alert"
              onClick={() => setError('')}
            >
              {error} <X size={12} />
            </button>
          )}
        </div>
        {!desktop && layout.chat && (
          <DeskAgent
            account={account}
            active={layout.active}
            files={tabs}
            cursors={cursors}
            handles={handles}
            states={states}
            selected={picked}
            toggle={(id) => selectTargets(picked.includes(id) ? picked.filter(i => i !== id) : [...picked, id])}
            changedScope={!!changedScope}
            confirmScope={() => selectTargets(picked.filter(id => layout.tabs.includes(id)), true)}
            draft={composer?.text || ''}
            setDraft={setDraft}
            jobs={jobs}
            run={run}
            transition={transition}
            locked={locks.current}
            close={() => setLayout((s) => ({ ...s, chat: false }))}
            open={open}
          />
        )}
      </div>
    </div>
  )
}
