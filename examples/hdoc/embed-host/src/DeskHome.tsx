import { useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Check,
  Clock3,
  Files,
  FolderOpen,
  Home,
  Layers,
  LogOut,
  Plus,
  Search,
  Settings2,
  Star,
  Upload,
  Users,
  X,
} from 'lucide-react'
import {
  baseName,
  createKinds,
  failText,
  FileGlyph,
  kindOf,
  kinds,
  PaperArt,
  type FileKind,
} from './deskFiles'
import { api, mutation, type Account, type FileEntry } from './hostApi'
type Props = {
  account: Account
  files: FileEntry[]
  stars: string[]
  recent: string[]
  star: (id: string) => void
  open: (id: string) => void
  add: (file: FileEntry) => void
  creating: FileKind | null
  setCreating: (kind: FileKind | null) => void
  error: string
}
export function DeskHome({
  account,
  files,
  stars,
  recent,
  star,
  open,
  add,
  creating,
  setCreating,
  error,
}: Props) {
  const [filter, setFilter] = useState('home'),
    [search, setSearch] = useState(''),
    [order, setOrder] = useState<'recent' | 'name'>('recent'),
    [name, setName] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const filterLabel =
    filter === 'stars'
      ? '星标文件'
      : filter === 'recent'
        ? '最近打开'
        : filter === 'home'
          ? '全部文件'
          : kinds[filter as FileKind]?.label
  const matched = files.filter(
    (f) =>
      (filter === 'home' ||
        (filter === 'stars' && stars.includes(f.id)) ||
        (filter === 'recent' && recent.includes(f.id)) ||
        kindOf(f.format) === filter) &&
      f.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  matched.sort((a, b) =>
    order === 'name'
      ? a.name.localeCompare(b.name, 'zh-CN')
      : (recent.includes(b.id) ? recent.length - recent.indexOf(b.id) : 0) -
          (recent.includes(a.id) ? recent.length - recent.indexOf(a.id) : 0) ||
        Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt),
  )
  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!creating || !name.trim() || busy) return
    setBusy(true)
    setNotice('')
    try {
      const ext = '.' + kinds[creating].extension
      const title = name.trim()
      const { file } = await api<{ file: FileEntry }>(
        '/files',
        mutation(account.csrf, {
          name: title.toLowerCase().endsWith(ext) ? title : title + ext,
        }),
      )
      setCreating(null)
      setName('')
      add(file)
    } catch (e) {
      setNotice(failText(e))
    } finally {
      setBusy(false)
    }
  }
  async function upload(file: File) {
    setBusy(true)
    setNotice('')
    try {
      const { file: entry } = await api<{ file: FileEntry }>(
        '/files?filename=' + encodeURIComponent(file.name),
        {
          method: 'POST',
          headers: {
            'X-Workspace-CSRF': account.csrf,
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        },
      )
      add(entry)
    } catch (e) {
      setNotice(failText(e))
    } finally {
      setBusy(false)
    }
  }
  const go = (next: string) => {
    setFilter(next)
    setSearch('')
  }
  return (
    <div className="desk-home">
      <nav className="desk-rail" aria-label="工作空间导航">
        <div className="desk-team">
          <span className="desk-team-logo">
            <Layers size={21} />
          </span>
          <div>
            <strong>{account.workspace.name || '我的工作空间'}</strong>
            <small>团队工作空间</small>
          </div>
        </div>
        <div className="desk-rail-list">
          {[
            { id: 'home', label: '首页', icon: Home },
            { id: 'recent', label: '最近打开', icon: Clock3 },
            { id: 'stars', label: '星标文件', icon: Star },
          ].map((n) => (
            <button
              key={n.id}
              aria-current={filter === n.id ? 'page' : undefined}
              onClick={() => go(n.id)}
            >
              <n.icon />
              {n.label}
            </button>
          ))}
        </div>
        <h3>文件类型</h3>
        <div className="desk-rail-list">
          {(Object.keys(kinds) as FileKind[]).map((k) => (
            <button
              key={k}
              aria-current={filter === k ? 'page' : undefined}
              onClick={() => go(k)}
            >
              <FileGlyph kind={k} size={16} />
              {kinds[k].label}
            </button>
          ))}
        </div>
        <div className="desk-rail-bottom">
          <a href="/admin#/documents">
            <FolderOpen />
            文件管理
          </a>
          <a href="/admin#/integration">
            <Settings2 />
            应用接入
          </a>
          {account.user.role === 'admin' && (
            <a href="/admin#/users">
              <Users />
              用户与角色
            </a>
          )}
          <div className="desk-user">
            <span>{account.user.displayName?.slice(-1) || '我'}</span>
            <strong>{account.user.displayName}</strong>
            <button
              title="退出登录"
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await api('/logout', mutation(account.csrf, {}))
                  location.assign('/')
                } catch (e) {
                  setNotice(failText(e))
                }
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </nav>
      <main className="desk-home-main">
        <div className="desk-breadcrumb">
          <Home size={15} /> <span>工作台</span>
          <span>/</span>
          <strong>{filter === 'home' ? '首页' : filterLabel}</strong>
        </div>
        <div className="desk-page-head">
          <div>
            <h1>{filter === 'home' ? '工作空间' : filterLabel}</h1>
            <p>
              {account.workspace.name || '我的工作空间'} <span> / </span>{' '}
              {account.user.displayName}
            </p>
          </div>
          <button
            className="desk-upload"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            <Upload size={16} />
            上传文件
          </button>
          <input
            hidden
            type="file"
            ref={picker}
            accept=".docx,.xlsx,.pptx,.pdf,.txt,.md,.html,.excalidraw,.png,.jpg,.jpeg,.webp"
            onChange={(e) => {
              if (e.target.files?.[0]) void upload(e.target.files[0])
              e.target.value = ''
            }}
          />
        </div>
        {filter === 'home' && (
          <section className="desk-new">
            <h2>新建文件</h2>
            <div className="desk-tiles">
              {createKinds.map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    setName('')
                    setNotice('')
                    setCreating(k)
                  }}
                  aria-label={'新建' + kinds[k].label}
                >
                  <PaperArt kind={k} />
                  <span>
                    {kinds[k].label}
                    <Plus size={14} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="desk-file-section">
          <div className="desk-files-head">
            <h2>
              {filter === 'home' ? '文件库' : filterLabel}{' '}
              <small>{matched.length}</small>
            </h2>
            <label className="desk-search">
              <Search size={15} />
              <input
                aria-label="搜索文件"
                placeholder="搜索文件"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button aria-label="清空搜索" onClick={() => setSearch('')}>
                  <X size={13} />
                </button>
              )}
            </label>
          </div>
          <div className="desk-list-head">
            <span>文件名称</span>
            <span>所有者</span>
            <button
              aria-label="切换文件排序"
              onClick={() => setOrder(order === 'recent' ? 'name' : 'recent')}
            >
              {order === 'recent' ? '最近使用' : '按名称'}{' '}
              <ArrowDownToLine size={11} />
            </button>
            <span />
          </div>
          {matched.map((f) => (
            <div className="desk-list-row" key={f.id}>
              <button
                className="desk-file-open"
                aria-label={'打开 ' + f.name}
                onClick={() => open(f.id)}
              >
                <FileGlyph kind={kindOf(f.format)} size={21} />
                <span>
                  <strong>{baseName(f.name)}</strong>
                  <small>{f.format.toUpperCase()}</small>
                </span>
              </button>
              <span className="desk-owner">{f.ownerName}</span>
              <time>
                {new Date(f.modifiedAt).toLocaleDateString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
              <button
                className={
                  'desk-star' + (stars.includes(f.id) ? ' picked' : '')
                }
                aria-label={
                  (stars.includes(f.id) ? '取消星标 ' : '星标 ') + f.name
                }
                aria-pressed={stars.includes(f.id)}
                onClick={() => star(f.id)}
              >
                <Star size={16} />
              </button>
            </div>
          ))}
          {!matched.length && (
            <div className="desk-empty">
              <Files />
              {search
                ? '没有匹配的文件'
                : filter === 'stars'
                  ? '给文件点亮星标后，可以在这里找到它。'
                  : filter === 'recent'
                    ? '打开过的文件会出现在这里。'
                    : '这里还没有文件。'}
            </div>
          )}
        </section>
        {(error || notice) && (
          <p role="alert" className="desk-error">
            {notice || error}
          </p>
        )}
      </main>
      {creating && (
        <div className="desk-shade">
          <form
            role="dialog"
            aria-label={'新建' + kinds[creating].label}
            className="desk-dialog"
            onSubmit={create}
          >
            <div>
              <FileGlyph kind={creating} />
              <h2>新建{kinds[creating].label}</h2>
              <button
                type="button"
                aria-label="取消新建"
                onClick={() => setCreating(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              文件名称
              <input
                autoFocus
                required
                maxLength={140}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={'未命名' + kinds[creating].label}
              />
            </label>
            {notice && <p role="alert">{notice}</p>}
            <button className="desk-primary" disabled={busy || !name.trim()}>
              <Check size={15} />
              创建并打开
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
