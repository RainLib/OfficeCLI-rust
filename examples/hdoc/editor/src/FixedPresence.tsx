import { useEffect, useMemo, useState, useRef } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Session } from './api.ts'
import { useI18n } from './i18n.tsx'
import {fixedViewportField,readFixedViewport,type FixedViewport} from './fixedViewport.ts'
import {workbookPresenceField,readWorkbookPresence,type WorkbookPresence} from './workbookPresence.ts'

export type FixedSelection = { page: number; nodeId: string; kind: 'text' | 'image' }
export type FixedPeer = { clientId: number; id: string; name: string; color: string; selection?: FixedSelection; viewport?:FixedViewport;workbook?:WorkbookPresence }
const colors = ['#3478c0', '#13866a', '#9a5abb', '#d17d20', '#d84a54']
function color(id: string) { return colors[[...id].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) >>> 0, 0) % colors.length] }
export function useFixedPresence(session: Session, selection: FixedSelection | null, disabled=false, viewport:FixedViewport|null=null,workbook:WorkbookPresence|null=null) {
  const [peers, setPeers] = useState<FixedPeer[]>([])
  const [connected, setConnected] = useState(false)
  const local = useMemo(() => ({ id: session.userId || crypto.randomUUID(), name: [...(session.displayName?.trim() || session.userId || 'User')].slice(0, 64).join('') }), [session.userId, session.displayName])
  const providerRef=useRef<HocuspocusProvider|null>(null)
  const latestSelection=useRef(selection);latestSelection.current=selection
  const latestViewport=useRef(viewport);latestViewport.current=viewport
  const latestWorkbook=useRef(workbook);latestWorkbook.current=workbook
  const [clientId,setClientId]=useState<number|null>(null)
  // Effect-owned resources survive StrictMode replay by creating a fresh
  // connection, rather than reconnecting a memoized, destroyed provider.
  useEffect(() => {
    setConnected(false);setPeers([])
    if(disabled)return
    const document=new Y.Doc()
    const provider=new HocuspocusProvider({url:session.collabUrl||import.meta.env.VITE_HCD_COLLAB_URL||'ws://127.0.0.1:8768',name:`fixed:${session.documentId}:0`,document,token:session.token})
    providerRef.current=provider;setClientId(document.clientID)
    const update = () => {
      const next: FixedPeer[] = []
      for (const [clientId, state] of provider.awareness?.getStates() || []) {
        const user = state.user as { id?: unknown; name?: unknown } | undefined
        if (typeof user?.id !== 'string' || typeof user.name !== 'string') continue
        const raw = state.selection as Partial<FixedSelection> | undefined
        const selection = raw && Number.isSafeInteger(raw.page) && raw.page!>=0 && typeof raw.nodeId === 'string' && raw.nodeId.length < 160 && (raw.kind === 'text' || raw.kind === 'image') ? raw as FixedSelection : undefined
        next.push({ clientId, id: user.id, name: [...user.name].slice(0, 64).join(''), color: color(user.id), selection,viewport:readFixedViewport(state[fixedViewportField])??undefined,workbook:readWorkbookPresence(state[workbookPresenceField])??undefined })
      }
      setPeers(next)
    }
    const status = ({ status }: { status: string }) => {setConnected(status === 'connected');if(status!=='connected')setPeers([])}
    provider.on('status', status)
    provider.awareness?.on('change', update)
    provider.awareness?.setLocalStateField('user', local)
    provider.awareness?.setLocalStateField('selection',latestSelection.current)
    provider.awareness?.setLocalStateField(fixedViewportField,latestViewport.current)
    provider.awareness?.setLocalStateField(workbookPresenceField,latestWorkbook.current)
    update()
    return () => { provider.off('status', status); provider.awareness?.off('change', update); provider.destroy(); document.destroy();if(providerRef.current===provider)providerRef.current=null }
  }, [session.documentId,session.collaborationEpoch,session.token,session.collabUrl,local,disabled])
  useEffect(() => { if(!disabled)providerRef.current?.awareness?.setLocalStateField('selection', selection) }, [disabled, selection?.page, selection?.nodeId, selection?.kind])
  useEffect(()=>{if(!disabled)providerRef.current?.awareness?.setLocalStateField(fixedViewportField,viewport)},[disabled,viewport])
  useEffect(()=>{if(!disabled)providerRef.current?.awareness?.setLocalStateField(workbookPresenceField,workbook)},[disabled,workbook])
  return { peers, others: peers.filter(peer => peer.clientId !== clientId), connected,clientId,localId:local.id }

}

export function FixedPresenceIndicator({ peers, connected, inactive=false,open,onOpen }: { peers: FixedPeer[]; connected: boolean;inactive?:boolean;open:boolean;onOpen:()=>void }) {
  const { t } = useI18n()
  const people = [...new Map(peers.map(peer => [peer.id, peer])).values()]
  return <button type="button" className="fixed-presence presence-trigger" aria-label={t('onlineCollaborators')} aria-expanded={open} onClick={onOpen}><span className={`fixed-presence-dot ${connected ? 'connected' : ''}`} /><span>{connected ? t('onlineCount', { count: people.length }) : inactive?t('readOnlyMode'):t('collaborationConnecting')}</span></button>
}

export function FixedCollaborationPanel({peers,localId,following,loading,onLocate,onFollow,onStop,canLocate,canFollow,activityText,onClose}:{peers:FixedPeer[];localId:string;following:number|null;loading?:number|null;onLocate:(peer:FixedPeer)=>void;onFollow:(peer:FixedPeer)=>void;onStop:()=>void;canLocate:(peer:FixedPeer)=>boolean;canFollow:(peer:FixedPeer)=>boolean;activityText:(peer:FixedPeer)=>string;onClose:()=>void}){
 const {t}=useI18n()
 // Keep the followed connection visible when one person has several windows.
 const members=new Map<string,FixedPeer>()
 for(const peer of peers){const previous=members.get(peer.id);if(!previous||peer.clientId===following||previous.clientId!==following&&!previous.viewport&&peer.viewport)members.set(peer.id,peer)}
 return <section className="collaboration-panel"><div className="panel-head"><h2>{t('collaborationPanelTitle')}</h2><button type="button" className="panel-close" aria-label={t('hidePanel')} onClick={onClose}>×</button></div><p className="collaboration-hint">{t('collaborationLocationHint')}</p><ul className="collaboration-members">{[...members.values()].map(peer=>{
  const own=peer.id===localId,active=following===peer.clientId,available=canLocate(peer),count=peers.filter(value=>value.id===peer.id).length
  return <li key={peer.id}><div className="collaboration-member-name"><i style={{background:peer.color}}>{Array.from(peer.name)[0]||'•'}</i><strong>{peer.name}{own?` ${t('you')}`:''}</strong></div><small>{own?t('yourView'):peer.viewport?`${peer.viewport.wordSection!==undefined&&peer.viewport.wordPage!==undefined?t('collaboratorWordLocation',{section:peer.viewport.wordSection,page:peer.viewport.wordPage}):t('collaboratorFixedPage',{page:peer.viewport.pageNumber})} · ${t('collaboratorViewProgress',{percent:Math.round(peer.viewport.y*100)})}`:t('collaboratorLocationPending')}{count>1?` · ${t('connectionCount',{count})}`:''}</small>{peer.selection?.nodeId&&<p>{t('collaboratorEditingText',{text:activityText(peer)})}</p>}{!own&&<div className="collaboration-member-actions"><button type="button" disabled={!available||loading===peer.clientId} onClick={()=>onLocate(peer)}>{t('locateCollaborator')}</button><button type="button" disabled={!canFollow(peer)&&!active} aria-pressed={active} onClick={()=>active?onStop():onFollow(peer)}>{t(active?'stopFollowing':'followCollaboratorAction')}</button></div>}{!own&&peer.viewport&&!available&&<small>{t('fixedLocationUnavailable')}</small>}</li>
 })}</ul>{!peers.length&&<p role="status">{t('collaborationConnecting')}</p>}</section>
}
