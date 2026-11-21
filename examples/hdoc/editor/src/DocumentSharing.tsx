import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Globe, Link, LockKeyhole, Pencil, Share2, X } from 'lucide-react'
import type { Session } from './api.ts'
import './sharing.css'

export type SharingPolicy = {
  visibility: 'private' | 'link' | 'public'
  permission: 'read' | 'write'
  expiresAt: number | null
  generation: number
  expired: boolean
  url: string
}
export type SharingActor = { id: string; displayName: string; isGuest: boolean }
type SharingContextValue = {
  fileId: string; canManage: boolean; actor?: SharingActor; sharedUrl?: string
  open: boolean; setOpen: (open: boolean) => void
}
const SharingContext = createContext<SharingContextValue | null>(null)

export function DocumentSharingProvider({ fileId, canManage, actor, sharedUrl, children }: {
  fileId: string; canManage: boolean; actor?: SharingActor; sharedUrl?: string; children: ReactNode
}) {
  const [open, setOpen] = useState(() => canManage && new URLSearchParams(location.search).get('share') === '1')
  return <SharingContext.Provider value={{ fileId, canManage, actor, sharedUrl, open, setOpen }}>{children}</SharingContext.Provider>
}

export function DocumentVisitorIdentity() {
  const sharing = useContext(SharingContext)
  if (!sharing?.actor?.isGuest) return null
  return <span className="document-visitor-identity" data-guest-id={sharing.actor.id} title="临时身份在同一浏览器内保留 24 小时">{sharing.actor.displayName}</span>
}

export function ShareControl() {
  const sharing = useContext(SharingContext)
  const [notice, setNotice] = useState('')
  if (!sharing) return null
  async function copyLink() {
    try { await navigator.clipboard.writeText(sharing!.sharedUrl || location.href); setNotice('链接已复制') }
    catch { setNotice('请复制浏览器地址栏中的分享链接') }
  }
  return <><button className="sharing-trigger" onClick={() => sharing.canManage ? sharing.setOpen(true) : void copyLink()} title={notice || '分享文档'}>
    <Share2 size={15} /><span>{sharing.canManage ? '分享' : notice || '复制链接'}</span>
  </button>{sharing.open && sharing.canManage && <ShareDialog fileId={sharing.fileId} onClose={() => sharing.setOpen(false)} />}</>
}

async function shareRequest(fileId: string, value?: unknown, signal?: AbortSignal) {
  const headers = new Headers()
  if (value !== undefined) {
    const response = await fetch('/workspace/api/session', { signal, credentials: 'same-origin' })
    if (!response.ok) throw new Error('登录已过期，请返回工作空间重新登录。')
    const account = await response.json() as { csrf: string }
    headers.set('X-Workspace-CSRF', account.csrf)
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`/workspace/api/files/${encodeURIComponent(fileId)}/sharing`, {
    method: value === undefined ? 'GET' : 'PUT', headers, signal, credentials: 'same-origin',
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  const result = await response.json() as { sharing: SharingPolicy; error?: string }
  if (!response.ok) throw new Error(result.error || '无法更新分享设置。')
  return result.sharing
}

function ShareDialog({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), groupId = useId()
  const [policy, setPolicy] = useState<SharingPolicy | null>(null)
  const [visibility, setVisibility] = useState<SharingPolicy['visibility']>('private')
  const [permission, setPermission] = useState<SharingPolicy['permission']>('read')
  const [expiry, setExpiry] = useState('current')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [reset, setReset] = useState(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const request = new AbortController()
    void shareRequest(fileId, undefined, request.signal).then(value => {
      setPolicy(value); setVisibility(value.visibility); setPermission(value.permission)
      setExpiry(value.visibility === 'private' || value.expired ? '7' : 'current')
    }).catch(cause => { if (!request.signal.aborted) setError(String(cause)) })
    return () => request.abort()
  }, [fileId])
  const dirty = !!policy && (visibility !== policy.visibility || visibility !== 'private' && (permission !== policy.permission || expiry !== 'current') || reset)
  async function save() {
    if (!policy || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const expiresAt = expiry === 'current' ? policy.expiresAt : expiry === 'never' ? null : Math.floor(Date.now() / 1000) + Number(expiry) * 86400
      const next = dirty ? await shareRequest(fileId, { visibility, permission, expiresAt, resetLink: reset }) : policy
      setPolicy(next); setExpiry('current'); setReset(false)
      if (visibility === 'private' && policy.visibility !== 'private') setNotice('已停止分享，访客不能再访问或提交修改。')
      else {
        try { await navigator.clipboard.writeText(next.url); setNotice('链接已复制') }
        catch { setNotice('设置已保存，请选中下方链接复制。') }
      }
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="sharing-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="sharing-heading"><h2 id={titleId}>分享文档</h2><button className="icon-button" aria-label="关闭分享" onClick={onClose}><X size={20} /></button></div>
    <p className="sharing-subtitle">选择访问范围和访客权限，可随时更改。</p>
    {policy ? <>
      <fieldset disabled={busy} className="sharing-options"><legend>谁可以打开</legend>
        {([
          ['private', '仅受邀成员', '只有已获授权的成员可以访问', LockKeyhole],
          ['link', '持链接的人', '通过此链接访问，无需注册或登录', Link],
          ['public', '公开访问', '可从公开文档入口找到并打开', Globe],
        ] as const).map(([value, label, description, Icon]) => <label key={value} className="sharing-option" data-selected={visibility === value}>
          <Icon size={20} /><span><strong>{label}</strong><small>{description}</small></span>
          <input type="radio" name={groupId} value={value} checked={visibility === value} aria-label={label} onChange={() => { setVisibility(value); setNotice(''); setReset(false) }} />
        </label>)}
      </fieldset>
      {visibility !== 'private' && <>
        <label className="sharing-field"><span>访客权限</span><select aria-label="访客权限" value={permission} disabled={busy} onChange={event => { setPermission(event.target.value as SharingPolicy['permission']); setNotice('') }}><option value="read">可查看</option><option value="write">可编辑</option></select></label>
        <p className="sharing-explanation">{permission === 'write' ? '访客会自动获得临时身份，修改会留下记录。打开文档后可直接编辑，无需登录。' : '访客打开后可直接阅读。查看权限不会授予编辑、历史恢复或管理权限。'}</p>
        <label className="sharing-field sharing-expiry"><span>链接有效期</span><select aria-label="链接有效期" value={expiry} disabled={busy} onChange={event => setExpiry(event.target.value)}>
          {expiry === 'current' && <option value="current">{policy.expiresAt ? new Date(policy.expiresAt * 1000).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '长期有效'}</option>}
          <option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="never">长期有效</option>
        </select></label>
      </>}
      {policy.expired && <p className="sharing-feedback">原分享已过期，保存新的有效期后才会重新开放。</p>}
      <label className="sharing-link-label">分享链接<input aria-label="分享链接" readOnly value={dirty ? '保存后生成当前权限的分享链接' : policy.url} onFocus={event => event.target.select()} /></label>
      {visibility === 'link' && policy.visibility === 'link' && <label className="sharing-reset"><input type="checkbox" checked={reset} disabled={busy} onChange={event => setReset(event.target.checked)} />重新生成链接，旧链接将失效</label>}
      <div className="sharing-actions"><a href={`/#/documents/${encodeURIComponent(fileId)}`} target="_blank" rel="noreferrer">管理受邀成员</a><button className="share-primary" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : notice === '链接已复制' ? <><Check size={16} />链接已复制</> : <><Copy size={16} />{visibility === 'private' && policy.visibility !== 'private' ? '保存并停止分享' : dirty ? '保存并复制链接' : '复制链接'}</>}</button></div>
      <p className="sharing-footnote">可随时修改权限、重置链接或停止分享。</p>
    </> : !error && <p role="status">正在读取分享设置…</p>}
    {error && <p role="alert" className="sharing-error">{error}</p>}{notice && <p role="status" className="sharing-feedback">{notice}</p>}
  </dialog>
}
