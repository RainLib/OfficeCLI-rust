import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Plus, UserMinus, Users, X } from 'lucide-react'
import { api, mutation, type Account, type FileEntry, type Project, type ProjectDetails, type ProjectFolder, type ProjectRole } from './hostApi'
import { failText } from './deskFiles'

const roleText = { owner: '所有者', manager: '管理员', editor: '可编辑', viewer: '可查看' }

export function folderTrail(folders: ReadonlyMap<string, ProjectFolder>, id: string | null) {
  const path: ProjectFolder[] = []
  const seen = new Set<string>()
  let folder = id ? folders.get(id) : undefined
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id)
    path.push(folder)
    folder = folder.parentId ? folders.get(folder.parentId) : undefined
  }
  return path.reverse()
}

export function ProjectIndex({ projects, loading, onOpen, onCreate }: {
  projects: Project[]; loading: boolean; onOpen: (id: string) => void; onCreate: () => void
}) {
  return <>
    <div className="desk-page-head">
      <div><h1>共享项目</h1></div>
      <button className="desk-upload" onClick={onCreate}><Plus size={16} />新建项目</button>
    </div>
    <section className="desk-project-index" aria-label="项目列表" aria-busy={loading}>
      {projects.map(project => <button key={project.id} onClick={() => onOpen(project.id)}>
        <span className="desk-project-icon"><FolderOpen size={21} /></span>
        <span><strong>{project.name}</strong><small>{roleText[project.role]}</small></span>
        <ChevronRight size={16} />
      </button>)}
      {!projects.length && <div className="desk-empty"><FolderOpen />{loading ? '正在读取项目…' : '这里还没有共享项目。'}</div>}
    </section>
  </>
}

export function ProjectFolders({ folders, writable, open, edit }: {
  folders: ProjectFolder[]; writable: boolean; open: (id: string) => void; edit: (folder: ProjectFolder) => void
}) {
  if (!folders.length) return null
  return <section className="desk-project-folders" aria-label="文件夹">
    {folders.map(folder => <div className="desk-folder-row" key={folder.id}>
      <button className="desk-folder-open" onClick={() => open(folder.id)}><Folder size={18} /><span>{folder.name}</span></button>
      {writable && <button className="desk-project-icon-button" aria-label={'管理文件夹 ' + folder.name} onClick={() => edit(folder)}><MoreHorizontal size={16} /></button>}
    </div>)}
  </section>
}

export function ProjectActions({ manager, writable, name, createFolder, openMembers, rename }: {
  manager: boolean; writable: boolean; name: string; createFolder: () => void; openMembers: () => void; rename: () => void
}) {
  return <>
    {writable && <button onClick={createFolder}><FolderPlus size={15} />新建文件夹</button>}
    <button onClick={openMembers}><Users size={15} />项目成员</button>
    {manager && <button aria-label={'重命名项目 ' + name} onClick={rename}><MoreHorizontal size={16} /></button>}
  </>
}

function ProjectDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="desk-project-dialog" aria-label={title} onCancel={close}>
    <header><h2>{title}</h2><button type="button" className="desk-project-icon-button" aria-label="关闭" onClick={close}><X size={18} /></button></header>
    {children}
  </dialog>
}

function FolderSelect({ folders, id, setId, exclude }: {
  folders: ProjectFolder[]; id: string | null; setId: (id: string | null) => void; exclude?: string
}) {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  return <label>文件夹<select value={id ?? ''} onChange={event => setId(event.target.value || null)}>
    <option value="">项目根目录</option>
    {folders.map(folder => {
      const path = folderTrail(byId, folder.id)
      return path.some(item => item.id === exclude) ? null :
        <option key={folder.id} value={folder.id}>{path.map(item => item.name).join(' / ')}</option>
    })}
  </select></label>
}

export type ProjectEdit = { kind: 'project'; project?: Project } | {
  kind: 'folder'; project: Project; folders: ProjectFolder[]; folder?: ProjectFolder; parentId: string | null; empty?: boolean
}
export function EditProjectDialog({ edit, account, close, saved }: {
  edit: ProjectEdit; account: Account; close: () => void; saved: (projectId: string, removedFolder?: string) => void
}) {
  const [name, setName] = useState(edit.kind === 'project' ? edit.project?.name ?? '' : edit.folder?.name ?? '')
  const [parent, setParent] = useState(edit.kind === 'folder' ? edit.parentId : null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const title = edit.kind === 'project' ? edit.project ? '重命名项目' : '新建项目' : edit.folder ? '管理文件夹' : '新建文件夹'
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      if (edit.kind === 'project') {
        const { project } = await api<{ project: Project }>('/projects' + (edit.project ? '/' + edit.project.id : ''),
          mutation(account.csrf, { name }, edit.project ? 'PATCH' : 'POST'))
        saved(project.id)
      } else {
        const base = '/projects/' + edit.project.id + '/folders'
        await api(base + (edit.folder ? '/' + edit.folder.id : ''),
          mutation(account.csrf, { name, parentId: parent }, edit.folder ? 'PATCH' : 'POST'))
        saved(edit.project.id)
      }
    } catch (cause) { setError(failText(cause)) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (busy || edit.kind !== 'folder' || !edit.folder) return
    setBusy(true); setError('')
    try {
      await api('/projects/' + edit.project.id + '/folders/' + edit.folder.id, mutation(account.csrf, {}, 'DELETE'))
      saved(edit.project.id, edit.folder.id)
    } catch (cause) { setError(failText(cause)) }
    finally { setBusy(false) }
  }
  return <ProjectDialog title={title} close={close}>
    <form onSubmit={event => void save(event)}>
      <label>{edit.kind === 'project' ? '项目名称' : '文件夹名称'}
        <input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} />
      </label>
      {edit.kind === 'folder' && edit.folder && <FolderSelect folders={edit.folders} id={parent} setId={setParent} exclude={edit.folder.id} />}
      {error && <p role="alert" className="desk-error">{error}</p>}
      <footer>{edit.kind === 'folder' && edit.folder && edit.empty &&
        <button type="button" disabled={busy} onClick={() => void remove()}>删除空文件夹</button>}
        <button className="desk-primary" disabled={busy || !name.trim()}>保存</button>
      </footer>
    </form>
  </ProjectDialog>
}

export function MoveProjectFileDialog({ file, projects, account, close, saved }: {
  file: FileEntry; projects: Project[]; account: Account; close: () => void; saved: (file: FileEntry) => void
}) {
  const destinations = projects.filter(project => project.role !== 'viewer' && (file.canManage || file.location?.projectId === project.id))
  const start = destinations.find(project => project.id === file.location?.projectId)?.id ?? destinations[0]?.id ?? ''
  const [projectId, setProject] = useState(start)
  const [folderId, setFolder] = useState<string | null>(start === file.location?.projectId ? file.location.folderId : null)
  const [details, setDetails] = useState<ProjectDetails | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!projectId) return
    const request = new AbortController()
    api<ProjectDetails>('/projects/' + projectId, { signal: request.signal })
      .then(setDetails).catch(cause => { if (!request.signal.aborted) setError(failText(cause)) })
    return () => request.abort()
  }, [projectId])
  async function move(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await api<{ file: FileEntry }>('/files/' + file.id + '/location',
        mutation(account.csrf, { projectId: projectId || null, folderId }, 'PUT'))
      saved(result.file)
    } catch (cause) { setError(failText(cause)) }
    finally { setBusy(false) }
  }
  return <ProjectDialog title="移动文件" close={close}>
    <form onSubmit={event => void move(event)}>
      <p className="desk-project-note">{file.name}</p>
      <label>目标项目<select value={projectId} onChange={event => { setProject(event.target.value); setFolder(null); setError('') }}>
        {file.canManage && <option value="">工作区</option>}
        {destinations.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      {projectId && details?.project.id === projectId && <FolderSelect folders={details.folders} id={folderId} setId={setFolder} />}
      {error && <p role="alert" className="desk-error">{error}</p>}
      <footer><button className="desk-primary" disabled={busy || !!projectId && details?.project.id !== projectId}>移动到这里</button></footer>
    </form>
  </ProjectDialog>
}

type Roster = {
  members: { id: string; name: string; role: ProjectRole | 'owner'; disabled: number }[]
  directory: { id: string; name: string; username: string }[]
}
const roleOptions = (['viewer', 'editor', 'manager'] as const).map(role => <option key={role} value={role}>{roleText[role]}</option>)

export function ProjectMembersDialog({ project, account, close, changed }: {
  project: Project; account: Account; close: () => void; changed: () => void
}) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [person, setPerson] = useState(''), [role, setRole] = useState<ProjectRole>('editor')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const path = '/projects/' + project.id + '/members'
  const manager = project.role === 'manager'
  useEffect(() => {
    const request = new AbortController()
    api<Roster>(path, { signal: request.signal }).then(setRoster)
      .catch(cause => { if (!request.signal.aborted) setError(failText(cause)) })
    return () => request.abort()
  }, [path])
  async function update(id: string, next: ProjectRole | null) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await api(path + '/' + id, mutation(account.csrf, { role: next }, 'PUT'))
      changed()
      setRoster(await api<Roster>(path))
      if (id === person) setPerson('')
    } catch (cause) { setError(failText(cause)) }
    finally { setBusy(false) }
  }
  const available = roster?.directory.filter(user => !roster.members.some(member => member.id === user.id)) || []
  return <ProjectDialog title="项目成员" close={close}>
    <ul className="desk-member-roster">
      {roster?.members.map(member => <li key={member.id}>
        <span>{member.name}{member.disabled ? ' · 已停用' : ''}</span>
        {manager && member.role !== 'owner' ? <>
          <select aria-label={member.name + '的角色'} value={member.role} disabled={busy || !!member.disabled}
            onChange={event => void update(member.id, event.target.value as ProjectRole)}>{roleOptions}</select>
          <button type="button" aria-label={'移除 ' + member.name} disabled={busy} className="desk-project-icon-button"
            onClick={() => void update(member.id, null)}><UserMinus size={16} /></button>
        </> : <small>{roleText[member.role]}</small>}
      </li>)}
    </ul>
    {manager && available.length > 0 && <form className="desk-member-invite" onSubmit={event => { event.preventDefault(); void update(person, role) }}>
      <label>添加成员<select required value={person} onChange={event => setPerson(event.target.value)}>
        <option value="">选择工作区成员</option>
        {available.map(user => <option key={user.id} value={user.id}>{user.name} · {user.username}</option>)}
      </select></label>
      <label>项目角色<select value={role} onChange={event => setRole(event.target.value as ProjectRole)}>{roleOptions}</select></label>
      <footer><button className="desk-primary" disabled={busy || !person}>添加到项目</button></footer>
    </form>}
    {error && <p role="alert" className="desk-error">{error}</p>}
  </ProjectDialog>
}
